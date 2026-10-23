const el = (id) => document.getElementById(id);

// Ícone único de engrenagem (configurar/editar) usado em toda a ferramenta. Botões do HTML marcam
// com data-icone="engrenagem" e recebem o ícone no carregamento; os criados via JS usam
// aplicarIconeEngrenagem. O title do botão vira também o aria-label.
const ICONE_ENGRENAGEM =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';

function aplicarIconeEngrenagem(btn) {
  btn.innerHTML = ICONE_ENGRENAGEM;
  if (btn.title) btn.setAttribute("aria-label", btn.title);
  return btn;
}

document.querySelectorAll('[data-icone="engrenagem"]').forEach(aplicarIconeEngrenagem);

// "adm" | "analista" | "visualizacao" — usado pra travar o campo IdCentral
// (só admin altera um valor já existente) na tela.
const USUARIO_PERFIL_ATUAL = document.body.dataset.usuarioPerfil || "adm";
// Id do app_usuarios do usuário logado — usado pra pré-selecionar "eu mesmo"
// como responsável ao criar uma tarefa nova.
const USUARIO_ID_ATUAL = document.body.dataset.usuarioId || "";

// Lê a resposta como texto e só então tenta JSON.parse — se vier HTML (ex.: página
// de erro do proxy quando o Render "acorda" do modo ocioso), mostra uma mensagem
// clara em vez do erro cru "Unexpected token '<'".
async function parseJsonResponse(resp) {
  const texto = await resp.text();
  try {
    return JSON.parse(texto);
  } catch (err) {
    if (!resp.ok) {
      throw new Error("O servidor demorou para responder (pode estar 'acordando' no plano gratuito). Tente novamente em alguns segundos.");
    }
    throw new Error("Resposta inesperada do servidor.");
  }
}

const saida = el("saida");
const overlay = el("overlay");
const modalTitulo = el("modal-titulo");
const inputArquivo = el("input-arquivo");
const arquivoNome = el("arquivo-nome");
const importPassoUpload = el("import-passo-upload");
const importPassoOrigemConvcli = el("import-passo-origem-convcli");
const importOrigemConvcliTexto = el("import-origem-convcli-texto");
const mapaCampos = el("mapa-campos");
const btnIniciarImport = el("btn-iniciar-import");
const progressoContainer = el("progresso-container");
const progressoBar = el("progresso-bar");
const progressoStatus = el("progresso-status");
const progressoPct = el("progresso-pct");
const importLog = el("import-log");
const btnExportarExcel = el("btn-exportar-excel");

document.querySelectorAll(".menu-cabecalho").forEach((cabecalho) => {
  cabecalho.addEventListener("click", () => {
    cabecalho.closest(".menu-grupo").classList.toggle("aberto");
  });
});

const estado = {
  autenticado: false,
  // idcentral do cliente ao qual a sessão está vinculada (autenticação pela
  // Ficha) — null = autenticação avulsa (Ferramentas Auxiliares).
  idcentralAutenticado: null,
  importTipo: null,
  // idcentral da Ficha que abriu o modal de importação, se veio de lá — null
  // quando o modal é aberto de Ferramentas Auxiliares (uso avulso).
  importIdcentral: null,
  fileId: null,
  colunas: [],
  campos: [],
  // Só setado por abrirModalImportDeConvcli (mapeamento de significado
  // conhecido, ver CONVERSOR_CLIENTES_PARA_API em app.py) — null = usa o
  // auto-mapeamento por texto normal de renderMapaCampos().
  mapeamentoSugerido: null,
  credencialAtualNome: null,
  conversorArquivo: null,
  conversorCor: null,
  ultimaConsulta: null,
};

const saidaTitulo = el("saida-titulo");
const btnLimpar = el("btn-limpar");

// O painel de Saída é compartilhado por 3 contextos (Kanban de Implantação,
// Kanban de Migração, resultado de Consultas em Ferramentas) — título e botão
// Limpar mudam conforme quem está usando o painel no momento.
function atualizarSaidaHeader(titulo, mostrarLimpar) {
  saidaTitulo.textContent = titulo;
  // Implantação/Migração: o título já está na topbar, então esconde aqui
  // (sem Limpar/Exportar visíveis, o cabeçalho inteiro some — ver CSS).
  // "Saída" (Ferramentas) continua, é rótulo da área de resultado.
  saidaTitulo.classList.toggle("oculto-topbar", !mostrarLimpar);
  btnLimpar.classList.toggle("hidden", !mostrarLimpar);
}

function setSaida(node) {
  saida.innerHTML = "";
  saida.appendChild(node);
  estado.ultimaConsulta = null;
  btnExportarExcel.classList.add("hidden");
}

function mostrarPlaceholder(msg) {
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = msg;
  setSaida(p);
}

function mostrarErro(msg) {
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  setSaida(p);
}

// O endpoint /Login da SSX só devolve AccessToken + validade (confirmado no
// Swagger) — nenhum "nome da base". app.py decodifica o AccessToken (JWT) e
// devolve os claims crus em data.claims; aqui tenta achar, por um nome de
// chave plausível, algo que pareça o nome da base/central — sem garantia
// nenhuma de que a chave certa está nessa lista (ninguém confirmou ainda
// qual é), por isso cada tela também guarda os claims crus num title/tooltip
// pra conferir à mão caso nenhum candidato bata.
function extrairNomeBaseDeClaims(claims) {
  if (!claims || typeof claims !== "object") return "";
  const candidatos = [
    "CentralName", "central_name", "CentralNome", "NomeBase", "nome_base",
    "BaseName", "base_name", "CompanyName", "company_name", "Empresa", "empresa",
    "Central", "Base", "Account", "account_name", "Tenant", "tenant",
    "Organization", "organization", "Nome", "name",
  ];
  for (const chave of candidatos) {
    const valor = claims[chave];
    if (typeof valor === "string" && valor.trim()) return valor.trim();
  }
  return "";
}

// null/"" sempre vão pro fim, independente da direção; números comparam como número
// e o resto vira texto (localeCompare com "numeric" pra ordenar "2" antes de "10").
function valorOrdenavel(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function ordenarLinhas(rows, coluna, direcao) {
  return rows.slice().sort((a, b) => {
    const va = valorOrdenavel(a[coluna]);
    const vb = valorOrdenavel(b[coluna]);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * direcao;
    return String(va).localeCompare(String(vb), "pt-BR", { numeric: true, sensitivity: "base" }) * direcao;
  });
}

function mostrarTabela(headers, rows, tipoExport, sortState) {
  const table = document.createElement("table");
  table.className = "tabela-saida";
  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  headers.forEach((h, i) => {
    const th = document.createElement("th");
    th.className = "th-ordenavel";
    th.textContent = h;
    if (sortState && sortState.coluna === i) {
      const seta = document.createElement("span");
      seta.className = "seta-ordenacao";
      seta.textContent = sortState.direcao === 1 ? " ▲" : " ▼";
      th.appendChild(seta);
    }
    th.addEventListener("click", () => {
      const direcao = sortState && sortState.coluna === i ? -sortState.direcao : 1;
      mostrarTabela(headers, ordenarLinhas(rows, i, direcao), tipoExport, { coluna: i, direcao });
    });
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = headers.length;
    td.textContent = "Nenhum registro encontrado.";
    td.style.color = "#6b7280";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    row.forEach((v) => {
      const td = document.createElement("td");
      td.textContent = v === null || v === undefined ? "" : String(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  setSaida(table);

  if (tipoExport) {
    estado.ultimaConsulta = { tipo: tipoExport, headers, rows };
    btnExportarExcel.classList.remove("hidden");
  }
}

btnExportarExcel.addEventListener("click", async () => {
  if (!estado.ultimaConsulta) return;
  btnExportarExcel.disabled = true;
  try {
    const r = await fetch("/api/exportar-excel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(estado.ultimaConsulta),
    });
    if (!r.ok) throw new Error("Falha ao gerar a planilha.");
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${estado.ultimaConsulta.tipo}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Erro ao exportar: ${String(err)}`);
  } finally {
    btnExportarExcel.disabled = false;
  }
});

async function atualizarStatus() {
  const r = await fetch("/api/status");
  const data = await parseJsonResponse(r);
  aplicarEstadoAuth(data.authenticated, data.idcentral || null);
}

function aplicarEstadoAuth(autenticado, idcentral) {
  estado.autenticado = autenticado;
  estado.idcentralAutenticado = idcentral || null;
  const pill = el("status-auth");
  const btnLogout = el("btn-logout");
  if (autenticado && idcentral) {
    // Vinculado a um cliente (autenticado pela Ficha) — as ferramentas
    // avulsas aqui em Ferramentas Auxiliares ficam bloqueadas até
    // reautenticar manualmente (o form abaixo faz isso ao submeter).
    pill.textContent = `Vinculado ao cliente ${idcentral}`;
    pill.className = "status-pill status-on";
    btnLogout.classList.remove("hidden");
  } else if (autenticado) {
    pill.textContent = "Autenticado";
    pill.className = "status-pill status-on";
    btnLogout.classList.remove("hidden");
  } else {
    pill.textContent = "Não autenticado";
    pill.className = "status-pill status-off";
    btnLogout.classList.add("hidden");
  }
}

// Nome do login salvo escolhido no <select> (se foi por lá que login/senha
// foram preenchidos) — só usado se a pessoa de fato clicar em "Autenticar"
// depois. Editar login/senha manualmente descarta essa associação, senão o
// crédito ficaria errado (mostrando o nome de um cliente salvo com uma
// senha diferente da que está de fato cadastrada).
let nomeCredencialPendente = null;

async function autenticarComCampos(nomeCredencial) {
  const login = el("login").value.trim();
  const senha = el("senha").value;
  if (!login || !senha) return;
  const btn = el("btn-autenticar");
  btn.disabled = true;
  btn.textContent = "Autenticando...";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, senha }),
    });
    const data = await parseJsonResponse(r);
    if (data.ok) {
      aplicarEstadoAuth(true, null); // login manual (avulso) — nunca vinculado a cliente
      estado.credencialAtualNome = nomeCredencial || null;
      mostrarPlaceholder("Autenticado com sucesso! Escolha uma consulta ou importação.");
    } else {
      aplicarEstadoAuth(false, null);
      mostrarErro(data.error || "Falha ao autenticar.");
    }
  } catch (err) {
    mostrarErro(String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Autenticar";
  }
}

el("login").addEventListener("input", () => { nomeCredencialPendente = null; });
el("senha").addEventListener("input", () => { nomeCredencialPendente = null; });

el("form-login").addEventListener("submit", (e) => {
  e.preventDefault();
  autenticarComCampos(nomeCredencialPendente);
  nomeCredencialPendente = null;
});

el("btn-logout").addEventListener("click", async () => {
  // Esse botão é só da sessão avulsa da SSX (Área de Importação e Consulta) —
  // /api/logout faz session.clear() de propósito (é "Sair da ferramenta", no
  // menu da engrenagem) e deslogaria do app inteiro por engano.
  await fetch("/api/logout-avulso", { method: "POST" });
  aplicarEstadoAuth(false);
  estado.credencialAtualNome = null;
  mostrarPlaceholder("Sessão encerrada.");
});

el("btn-limpar").addEventListener("click", () => {
  mostrarPlaceholder("Saída limpa.");
});

// --- LOGINS SALVOS ---
const overlayCred = el("overlay-credenciais");
const selectCredencial = el("select-credencial");
const listaCredenciais = el("lista-credenciais");
const formCredencial = el("form-nova-credencial");
const inputCredNome = el("cred-nome");
const inputCredLogin = el("cred-login");
const inputCredSenha = el("cred-senha");
const btnSalvarCredencial = el("btn-salvar-credencial");
const btnCancelarEdicaoCredencial = el("btn-cancelar-edicao-credencial");

let credenciaisCache = [];
let editandoCredencialId = null;

async function carregarCredenciais() {
  const r = await fetch("/api/credenciais");
  const data = await parseJsonResponse(r);
  credenciaisCache = data.credenciais || [];
  renderSelectCredenciais();
  renderListaCredenciais();
}

function renderSelectCredenciais() {
  const atual = selectCredencial.value;
  selectCredencial.innerHTML = '<option value="">Cliente salvo...</option>';
  credenciaisCache.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.nome;
    selectCredencial.appendChild(opt);
  });
  selectCredencial.value = atual;
}

selectCredencial.addEventListener("change", () => {
  const cred = credenciaisCache.find((c) => c.id === selectCredencial.value);
  if (!cred) return;
  // Só preenche os campos — quem autentica de fato é o botão "Autenticar"
  // (form-login submit), pra nunca autenticar sozinho ao trocar a seleção.
  el("login").value = cred.login;
  el("senha").value = cred.senha;
  nomeCredencialPendente = cred.nome;
  selectCredencial.value = "";
});

function renderListaCredenciais() {
  listaCredenciais.innerHTML = "";
  if (credenciaisCache.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nenhum login salvo ainda.";
    listaCredenciais.appendChild(p);
    return;
  }

  const table = document.createElement("table");
  table.className = "tabela-credenciais";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Nome</th><th>Login</th><th>Senha</th><th></th></tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  credenciaisCache.forEach((c) => {
    const tr = document.createElement("tr");

    const tdNome = document.createElement("td");
    tdNome.textContent = c.nome;
    if (c.origem === "cliente") {
      const tagCliente = document.createElement("span");
      tagCliente.className = "tag-momento";
      tagCliente.title = "Cadastrada na configuração do cliente (Ficha) — edite por lá.";
      tagCliente.textContent = " cliente";
      tdNome.appendChild(tagCliente);
    }

    const tdLogin = document.createElement("td");
    tdLogin.textContent = c.login;

    const tdSenha = document.createElement("td");
    const spanSenha = document.createElement("span");
    spanSenha.className = "senha-mascarada";
    spanSenha.textContent = "••••••";
    spanSenha.title = "Clique para mostrar/ocultar";
    let visivel = false;
    spanSenha.addEventListener("click", () => {
      visivel = !visivel;
      spanSenha.textContent = visivel ? c.senha : "••••••";
    });
    tdSenha.appendChild(spanSenha);

    const tdAcoes = document.createElement("td");
    tdAcoes.className = "acoes-credencial";

    const btnUsar = document.createElement("button");
    btnUsar.textContent = "Usar";
    btnUsar.addEventListener("click", async () => {
      el("login").value = c.login;
      el("senha").value = c.senha;
      overlayCred.classList.add("hidden");
      await autenticarComCampos(c.nome);
    });

    tdAcoes.appendChild(btnUsar);

    // Credencial "de cliente" (vinda da Ficha) só se edita/exclui por lá —
    // esta lista é read-only pra essas, pra nunca dessincronizar os dois
    // cadastros.
    if (c.origem !== "cliente") {
      const btnEditar = document.createElement("button");
      btnEditar.textContent = "Editar";
      btnEditar.className = "btn-secondary";
      btnEditar.addEventListener("click", () => abrirEdicaoCredencial(c));

      const btnExcluir = document.createElement("button");
      btnExcluir.textContent = "Excluir";
      btnExcluir.className = "btn-secondary";
      btnExcluir.addEventListener("click", () => excluirCredencial(c.id));

      tdAcoes.appendChild(btnEditar);
      tdAcoes.appendChild(btnExcluir);
    }

    tr.appendChild(tdNome);
    tr.appendChild(tdLogin);
    tr.appendChild(tdSenha);
    tr.appendChild(tdAcoes);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  listaCredenciais.appendChild(table);
}

function resetFormCredencial() {
  formCredencial.reset();
  editandoCredencialId = null;
  btnSalvarCredencial.textContent = "Adicionar";
  btnCancelarEdicaoCredencial.classList.add("hidden");
}

function abrirEdicaoCredencial(c) {
  inputCredNome.value = c.nome;
  inputCredLogin.value = c.login;
  inputCredSenha.value = c.senha;
  editandoCredencialId = c.id;
  btnSalvarCredencial.textContent = "Salvar edição";
  btnCancelarEdicaoCredencial.classList.remove("hidden");
  inputCredNome.focus();
}

btnCancelarEdicaoCredencial.addEventListener("click", resetFormCredencial);

formCredencial.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    nome: inputCredNome.value.trim(),
    login: inputCredLogin.value.trim(),
    senha: inputCredSenha.value,
  };
  if (!payload.nome || !payload.login || !payload.senha) return;
  try {
    const url = editandoCredencialId ? `/api/credenciais/${editandoCredencialId}` : "/api/credenciais";
    const method = editandoCredencialId ? "PUT" : "POST";
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErro(data.error || "Falha ao salvar login.");
    resetFormCredencial();
    await carregarCredenciais();
  } catch (err) {
    mostrarErro(String(err));
  }
});

async function excluirCredencial(id) {
  if (!confirm("Remover este login salvo?")) return;
  const r = await fetch(`/api/credenciais/${id}`, { method: "DELETE" });
  const data = await parseJsonResponse(r);
  if (!data.ok) return mostrarErro(data.error || "Falha ao excluir.");
  await carregarCredenciais();
}

const btnGerenciarLogins = el("btn-gerenciar-logins");
if (btnGerenciarLogins) {
  btnGerenciarLogins.addEventListener("click", () => {
    overlayCred.classList.remove("hidden");
  });
}
el("cred-fechar").addEventListener("click", () => {
  overlayCred.classList.add("hidden");
  resetFormCredencial();
});

carregarCredenciais();

el("botoes-consultas").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-tipo]");
  if (!btn) return;
  if (!estado.autenticado) return mostrarErro("Autentique-se primeiro.");
  const tipo = btn.dataset.tipo;
  mostrarPlaceholder("Consultando...");
  // Na sub-tela de Importação/Consulta o painel de Saída fica embaixo de
  // Autenticação + Importação + Consultas — rola até ele pra não deixar o
  // resultado escondido, exigindo rolar a página manualmente pra ver.
  el("tela-saida-wrapper").scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    const r = await fetch(`/api/list/${tipo}`);
    const data = await parseJsonResponse(r);
    if (data.ok) {
      mostrarTabela(data.headers, data.rows, tipo);
    } else {
      mostrarErro(data.error || "Falha na consulta.");
    }
  } catch (err) {
    mostrarErro(String(err));
  }
});

// Perfil "visualizacao" nem tem essa seção no HTML (só lê, nenhuma ação) —
// #botoes-import não existe no DOM pra esse perfil.
if (el("botoes-import")) {
  el("botoes-import").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-tipo]");
    if (!btn) return;
    if (!estado.autenticado) return mostrarErro("Autentique-se primeiro.");
    if (btn.dataset.tipo === "deletar-veiculos") {
      abrirModalDeletarVeiculos();
      return;
    }
    if (btn.dataset.tipo === "associar-rastreadores") {
      abrirModalAssociarRastreadores();
      return;
    }
    abrirModalImport(btn.dataset.tipo);
  });
}

// --- DASHBOARD ---
const STATUS_COR = {
  Aguardando: "var(--azul)",
  Enviado: "var(--amarelo)",
  Migrado: "var(--verde)",
  Enviar: "var(--vermelho)",
  Cancelado: "var(--cinza-500)",
};
const STATUS_ORDEM = ["Aguardando", "Enviado", "Migrado", "Enviar", "Cancelado"];

// Cores fixas por marco de Implantação, só pra visualização agregada no
// Dashboard (funil) — evita usar vermelho aqui, que já tem significado de
// "problema" (Atrasado/Red Flag) em outro lugar da tela.
const MARCO_COR = {
  "marco-1": "var(--azul)",
  "marco-2": "var(--turquesa)",
  "marco-3": "var(--violeta)",
  "marco-4": "var(--amarelo)",
  "marco-5": "var(--amarelo-escuro)",
  concluido: "var(--verde)",
};

// Monta a barra segmentada + legenda (reaproveitado por "Veículos por status"
// e pelo "Funil de Implantação" no Dashboard novo) — mesmo componente visual
// de renderDashboard() abaixo, só generalizado pra qualquer distribuição
// categórica com cor fixa por chave. `labels` é opcional: mapa chave->texto
// de exibição, cai pra própria chave quando ausente.
function construirBarraDistribuicao(ordem, cores, contagens, total, labels) {
  const wrap = document.createElement("div");
  const bar = document.createElement("div");
  bar.className = "status-bar";
  const legenda = document.createElement("div");
  legenda.className = "status-legenda";

  ordem.forEach((chave) => {
    const qtd = contagens[chave] || 0;
    const pct = total ? (qtd / total) * 100 : 0;
    const texto = (labels && labels[chave]) || chave;

    if (qtd > 0) {
      const seg = document.createElement("div");
      seg.className = "status-bar-seg";
      seg.style.width = `${pct}%`;
      seg.style.background = cores[chave];
      seg.title = `${texto}: ${qtd} (${pct.toFixed(1)}%)`;
      bar.appendChild(seg);
    }

    const item = document.createElement("div");
    item.className = "status-legenda-item";
    const dot = document.createElement("span");
    dot.className = "status-legenda-dot";
    dot.style.background = cores[chave];
    const nomeSpan = document.createElement("span");
    nomeSpan.textContent = texto;
    const valor = document.createElement("span");
    valor.className = "status-legenda-valor";
    valor.textContent = `${qtd} (${pct.toFixed(1)}%)`;
    item.appendChild(dot);
    item.appendChild(nomeSpan);
    item.appendChild(valor);
    legenda.appendChild(item);
  });

  wrap.appendChild(bar);
  wrap.appendChild(legenda);
  return wrap;
}

// "Ver indicadores" saiu do menu de Ferramentas Auxiliares (vai ser integrado
// na área de Dashboard no futuro) — carregarDashboard() fica sem chamador por
// enquanto, pronta pra ser reaproveitada nessa integração.
async function carregarDashboard() {
  mostrarPlaceholder("Carregando indicadores...");
  try {
    const r = await fetch("/api/dashboard");
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErro(data.error || "Falha ao carregar indicadores.");
    renderDashboard(data);
  } catch (err) {
    mostrarErro(String(err));
  }
}

function renderDashboard(data) {
  const wrapper = document.createElement("div");
  wrapper.className = "dashboard-wrapper";

  const tiles = document.createElement("div");
  tiles.className = "dashboard-tiles";
  [
    { valor: data.total_clientes, label: "Clientes em migração" },
    { valor: data.total_veiculos, label: "Veículos cadastrados" },
  ].forEach(({ valor, label }) => {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const l = document.createElement("div");
    l.className = "stat-tile-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "stat-tile-valor";
    v.textContent = valor;
    tile.appendChild(l);
    tile.appendChild(v);
    tiles.appendChild(tile);
  });
  wrapper.appendChild(tiles);

  const secaoStatus = document.createElement("div");
  secaoStatus.className = "dashboard-secao";
  const titulo = document.createElement("h3");
  titulo.textContent = "Veículos por status";
  secaoStatus.appendChild(titulo);

  const total = data.total_veiculos || 0;
  const bar = document.createElement("div");
  bar.className = "status-bar";
  const legenda = document.createElement("div");
  legenda.className = "status-legenda";

  STATUS_ORDEM.forEach((status) => {
    const qtd = data.por_status[status] || 0;
    const pct = total ? (qtd / total) * 100 : 0;

    if (qtd > 0) {
      const seg = document.createElement("div");
      seg.className = "status-bar-seg";
      seg.style.width = `${pct}%`;
      seg.style.background = STATUS_COR[status];
      seg.title = `${status}: ${qtd} (${pct.toFixed(1)}%)`;
      bar.appendChild(seg);
    }

    const item = document.createElement("div");
    item.className = "status-legenda-item";
    const dot = document.createElement("span");
    dot.className = "status-legenda-dot";
    dot.style.background = STATUS_COR[status];
    const texto = document.createElement("span");
    texto.textContent = status;
    const valor = document.createElement("span");
    valor.className = "status-legenda-valor";
    valor.textContent = `${qtd} (${pct.toFixed(1)}%)`;
    item.appendChild(dot);
    item.appendChild(texto);
    item.appendChild(valor);
    legenda.appendChild(item);
  });

  secaoStatus.appendChild(bar);
  secaoStatus.appendChild(legenda);
  wrapper.appendChild(secaoStatus);

  setSaida(wrapper);
}

// --- COMBOBOX PESQUISÁVEL (genérico) ---
// Input de texto que filtra uma lista de opções {value, label} conforme
// digita, mostra sugestões abaixo, seleciona no clique. Usado hoje só em
// Estado/Cidade do Decisor, mas serve pra qualquer lista suspensa grande.
function criarComboboxPesquisavel(placeholder) {
  const wrap = document.createElement("div");
  wrap.className = "combobox-pesquisavel";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder || "Digite para buscar...";
  input.autocomplete = "off";
  wrap.appendChild(input);

  const lista = document.createElement("div");
  lista.className = "combobox-lista hidden";
  wrap.appendChild(lista);

  // modoLivre: quando não há lista pra escolher (ex.: API do IBGE fora do ar),
  // o campo vira texto livre de verdade — não limpa ao perder o foco, e não
  // mostra "nenhuma opção encontrada" enquanto digita.
  const api = { wrap, input, opcoes: [], valor: "", aoSelecionar: null, modoLivre: false };

  function normalizar(txt) {
    return String(txt || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  function renderLista() {
    if (api.modoLivre && api.opcoes.length === 0) {
      lista.classList.add("hidden");
      return;
    }
    const termo = normalizar(input.value);
    const filtradas = termo
      ? api.opcoes.filter((o) => normalizar(o.label).includes(termo))
      : api.opcoes;
    lista.innerHTML = "";
    if (filtradas.length === 0) {
      const vazio = document.createElement("div");
      vazio.className = "combobox-item combobox-item-vazio";
      vazio.textContent = "Nenhuma opção encontrada";
      lista.appendChild(vazio);
    } else {
      filtradas.slice(0, 200).forEach((o) => {
        const item = document.createElement("div");
        item.className = "combobox-item";
        item.textContent = o.label;
        // mousedown (não click) pra disparar antes do blur do input fechar a lista.
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          api.valor = o.value;
          input.value = o.label;
          lista.classList.add("hidden");
          if (api.aoSelecionar) api.aoSelecionar(o.value, o);
        });
        lista.appendChild(item);
      });
    }
    lista.classList.remove("hidden");
  }

  input.addEventListener("focus", () => {
    if (!input.disabled) { if (!api.modoLivre) input.select(); renderLista(); }
  });
  input.addEventListener("input", () => {
    if (api.modoLivre) { api.valor = input.value; return; }
    const opcaoAtual = api.opcoes.find((o) => o.value === api.valor);
    if (!opcaoAtual || opcaoAtual.label !== input.value) api.valor = "";
    renderLista();
  });
  input.addEventListener("blur", () => {
    setTimeout(() => lista.classList.add("hidden"), 150);
    if (!api.modoLivre && !api.valor) input.value = "";
  });

  api.setOpcoes = (opcoes) => { api.opcoes = opcoes || []; };
  api.setValor = (value) => {
    const opt = api.opcoes.find((o) => o.value === value);
    api.valor = value || "";
    input.value = opt ? opt.label : (value || "");
  };
  api.limpar = () => { api.valor = ""; input.value = ""; api.modoLivre = false; };

  return api;
}

// --- CLIENTES EM IMPLANTAÇÃO ---
const overlayImplantacaoCliente = el("overlay-implantacao-cliente");
const modalImplantacaoClienteEl = el("modal-implantacao-cliente");
const implantacaoClienteSidebarConfig = el("implantacao-cliente-sidebar-config");
const formImplantacaoCliente = el("form-implantacao-cliente");
const implantacaoClienteModalTitulo = el("implantacao-cliente-modal-titulo");
const inputImplantacaoClienteIdcentral = el("implantacao-cliente-idcentral");
const inputImplantacaoClienteNome = el("implantacao-cliente-nome");
const inputImplantacaoClienteData = el("implantacao-cliente-data");
const inputImplantacaoClienteObjetivo = el("implantacao-cliente-objetivo");
const inputImplantacaoClienteValor = el("implantacao-cliente-valor");
const inputImplantacaoClienteCsm = el("implantacao-cliente-csm");
const inputImplantacaoClienteTemMigracao = el("implantacao-cliente-tem-migracao");
const inputImplantacaoClienteMomento = el("implantacao-cliente-momento");
const inputImplantacaoClienteFlag = el("implantacao-cliente-flag");
const inputImplantacaoClienteVendedor = el("implantacao-cliente-vendedor");
const inputImplantacaoClientePersona = el("implantacao-cliente-persona");
const inputImplantacaoClienteDecisorNome = el("implantacao-cliente-decisor-nome");
const inputImplantacaoClienteDecisorWhatsapp = el("implantacao-cliente-decisor-whatsapp");
const wrapImplantacaoClienteComplementares = el("implantacao-cliente-campos-complementares");
const btnSalvarImplantacaoCliente = el("btn-salvar-implantacao-cliente");
const inputImplantacaoClienteImplantado = el("implantacao-cliente-implantado");
const infoImplantacaoClienteImplantado = el("implantacao-cliente-implantado-info");

function atualizarCampoImplantado(cliente) {
  inputImplantacaoClienteImplantado.value = cliente && cliente.implantado ? "sim" : "nao";
  infoImplantacaoClienteImplantado.textContent = cliente && cliente.implantado && cliente.implantado_em
    ? `desde ${formatarDataBRSimples(cliente.implantado_em)}${cliente.implantado_por ? ` · ${cliente.implantado_por}` : ""}`
    : "";
}

// Switch "Implantado" — salva na hora (endpoint próprio, com data/quem e
// histórico), sem depender do "Salvar edição" do formulário. Também é
// chamado pela sugestão que aparece quando o Marco 3 conclui.
async function salvarImplantadoCliente(cliente, implantado, recarregar = true) {
  try {
    const r = await fetch(`/api/clientes/${cliente.id}/implantado`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ implantado }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      alert(`Erro ao salvar: ${data.error || "falha desconhecida"}`);
    } else {
      Object.assign(cliente, {
        implantado: data.implantado, implantado_em: data.implantado_em, implantado_por: data.implantado_por,
      });
      // Atualiza o que está por trás do modal (tag "Implantado" da Ficha).
      if (!recarregar) {
        // quem chamou recarrega depois
      } else if (fichaClienteAtual && fichaClienteAtual.implantacao && fichaClienteAtual.implantacao.id === cliente.id) {
        await carregarFichaCliente(fichaClienteAtual.implantacao.idcentral, fichaAbaAtual);
      } else {
        await carregarImplantacaoClientes();
      }
    }
  } catch (err) {
    alert(`Erro ao salvar: ${String(err)}`);
  }
  atualizarCampoImplantado(cliente);
}

inputImplantacaoClienteImplantado.addEventListener("change", async () => {
  const cliente = implantacaoClienteEmEdicao;
  if (!cliente) return;
  inputImplantacaoClienteImplantado.disabled = true;
  await salvarImplantadoCliente(cliente, inputImplantacaoClienteImplantado.value === "sim");
  inputImplantacaoClienteImplantado.disabled = false;
});

// Estado/Cidade do Decisor — comboboxes pesquisáveis. Estado vem de uma lista
// fixa (carregada 1x); Cidade depende do estado escolhido (API do IBGE,
// carregada sob demanda e cacheada por UF pelo próprio backend).
const comboDecisorEstado = criarComboboxPesquisavel("Digite o estado...");
el("implantacao-cliente-decisor-estado-wrap").appendChild(comboDecisorEstado.wrap);
const comboDecisorCidade = criarComboboxPesquisavel("Escolha o estado primeiro");
comboDecisorCidade.input.disabled = true;
el("implantacao-cliente-decisor-cidade-wrap").appendChild(comboDecisorCidade.wrap);

let estadosBrasilCache = null;
async function carregarEstadosBrasil() {
  if (estadosBrasilCache) return estadosBrasilCache;
  try {
    const r = await fetch("/api/localidades/estados");
    const data = await parseJsonResponse(r);
    estadosBrasilCache = data.ok ? data.estados.map((e) => ({ value: e.sigla, label: e.nome })) : [];
  } catch (err) {
    estadosBrasilCache = [];
  }
  comboDecisorEstado.setOpcoes(estadosBrasilCache);
  return estadosBrasilCache;
}

const cacheMunicipiosPorUf = {};
async function carregarMunicipiosDoEstado(uf, cidadeAtual) {
  comboDecisorCidade.limpar();
  if (!uf) {
    comboDecisorCidade.setOpcoes([]);
    comboDecisorCidade.input.disabled = true;
    comboDecisorCidade.input.placeholder = "Escolha o estado primeiro";
    return;
  }
  comboDecisorCidade.input.disabled = true;
  comboDecisorCidade.input.placeholder = "Carregando cidades...";
  try {
    if (!cacheMunicipiosPorUf[uf]) {
      const r = await fetch(`/api/localidades/municipios/${uf}`);
      const data = await parseJsonResponse(r);
      if (!data.ok) throw new Error(data.error || "Falha ao carregar cidades.");
      cacheMunicipiosPorUf[uf] = data.municipios.map((nome) => ({ value: nome, label: nome }));
    }
    comboDecisorCidade.setOpcoes(cacheMunicipiosPorUf[uf]);
    comboDecisorCidade.input.disabled = false;
    comboDecisorCidade.input.placeholder = "Digite a cidade...";
    if (cidadeAtual) comboDecisorCidade.setValor(cidadeAtual);
  } catch (err) {
    // Fallback: API do IBGE fora do ar agora — deixa como texto livre pra
    // não travar o cadastro por causa de um serviço externo.
    comboDecisorCidade.setOpcoes([]);
    comboDecisorCidade.modoLivre = true;
    comboDecisorCidade.input.disabled = false;
    comboDecisorCidade.input.placeholder = "Digite a cidade (busca indisponível agora)";
    comboDecisorCidade.input.value = cidadeAtual || "";
    comboDecisorCidade.valor = cidadeAtual || "";
  }
}

comboDecisorEstado.aoSelecionar = (uf) => carregarMunicipiosDoEstado(uf, "");

// Tentativa de migração em andamento do cliente que está aberto no modal agora
// (ou null se não tiver nenhuma) — carregada em abrirModalImplantacaoCliente.
// Esse campo só serve pra INICIAR uma migração (Sim, quando não há nenhuma
// ativa ainda); os detalhes (plataforma, planilha, etc.) ficam separados, em
// "Configurações de Migração" — acessível só pelo sidebar da Ficha (engrenagem
// > Migração), não daqui, pra não duplicar o mesmo caminho de duas formas.
let implantacaoClienteMigracaoAtual = null;

let implantacaoClienteEditandoId = null;
// Guarda o objeto do cliente sendo editado (não só o id) — o campo
// "Cliente implantado?" lê/atualiza os dados dele.
let implantacaoClienteEmEdicao = null;
let implantacaoClientesCache = [];
let implantacaoFiltroTexto = "";
let implantacaoFiltroCsm = "";
// Filtros da barra de números do Kanban ("" = sem filtro).
let implantacaoFiltroStatus = ""; // "ok" | "atrasado"
let implantacaoFiltroFlag = ""; // "Yellow Flag" | "Red Flag" | "Black Flag"
let implantacaoFiltroParado = false;
let implantacaoView = "kanban"; // "kanban" | "lista"
// Precisa bater com as opções do <select id="implantacao-cliente-etapa"> e com
// IMPLANTACAO_ETAPAS no app.py — são as colunas oficiais do Kanban de Implantação.
const IMPLANTACAO_ETAPA_LABELS = {
  "marco-1": "Marco 1 (7 dias)",
  "marco-2": "Marco 2 (21 dias)",
  "marco-3": "Marco 3 (60 dias)",
  "marco-4": "Marco 4 (120 dias)",
  "marco-5": "Marco 5 (180 dias)",
  "concluido": "100% Implantados",
};
const IMPLANTACAO_ETAPAS_ORDEM = ["marco-1", "marco-2", "marco-3", "marco-4", "marco-5", "concluido"];

// Clique no card/linha do cliente (Implantação e Migração): vai direto pra
// Ficha do Cliente (Fase 3a) quando o cliente já tem IdCentral preenchido —
// senão cai no modal de sempre (linha do tempo / veículos), já que a Ficha
// não existe sem esse campo pra ligar os dois lados.
function abrirClienteOuFicha(cliente, abrirModalFn) {
  if (cliente.idcentral) {
    irParaFicha(cliente.idcentral);
  } else {
    abrirModalFn(cliente);
  }
}

// Ícone (não chip com texto — card tem que ficar enxuto) de bandeira pro
// card do Kanban. Cor fixa, mesmo racional das tags da Ficha.
const FLAG_ICONE_COR = {
  "Yellow Flag": "#D97706",
  "Red Flag": "#DC2626",
  "Black Flag": "#1F2937",
};

function criarIconeFlag(flag) {
  const cor = FLAG_ICONE_COR[flag];
  if (!cor) return null;
  const span = document.createElement("span");
  span.className = "kanban-card-flag-icone";
  span.title = flag;
  span.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="${cor}"><path d="M5 3v18h2v-7h11l-3-4 3-4H7V3z"/></svg>`;
  return span;
}

// Heurística de risco (sem precisar de Flag marcada manualmente): cliente já
// tem >60 dias de casa mas continua com pouca placa rodando (<30 UR's, dado
// vindo da planilha via dados_planilha) — mesmo sinal usado no painel de CS
// de referência. Só desenha borda vermelha no card, sem texto extra.
function clientePossivelRisco(c) {
  const dias = diasDesdeEntrada(c.data_entrada);
  const urs = parseInt((c.dados_planilha || {})["7 - UR's"], 10);
  return dias !== null && dias > 60 && !Number.isNaN(urs) && urs < 30;
}

// --- KANBAN DE IMPLANTAÇÃO (visual da tela de Marcos do painel de CS) ---
// Só as 5 colunas de marco; quem concluiu os 5 (etapa "concluido") sai do
// board e aparece no modal "Implantados", com a data de conclusão.

// Placas (UR's) vêm da planilha (dados_planilha) — null quando não tem.
function placasCliente(c) {
  const urs = parseInt((c.dados_planilha || {})["7 - UR's"], 10);
  return Number.isNaN(urs) ? null : urs;
}

function clienteAtrasadoNoMarco(c) {
  return c.etapa !== "concluido" && marcoAtrasado(c.data_entrada, c.etapa, c.marcos_concluidos);
}

// Motivo do atraso — árvore de decisão do Playbook SSX (seção 17). As chaves
// batem com MOTIVOS_ATRASO do app.py.
const MOTIVOS_ATRASO = {
  nao_executa: { rotulo: "Não consegue executar", acao: "Reforçar orientação, prática e validação." },
  nao_entende: { rotulo: "Não entende o objetivo", acao: "Retomar contexto, dor e expectativa." },
  sem_estrutura: { rotulo: "Não possui estrutura", acao: "Registrar impedimento e acionar responsável." },
  nao_responde: { rotulo: "Não responde", acao: "Reengajar e avaliar risco de relacionamento." },
  problema_tecnico: { rotulo: "Problema técnico", acao: "Acionar área técnica com contexto e evidência." },
  expectativa: { rotulo: "Expectativa desalinhada", acao: "Revalidar o que foi prometido, possível e próximo passo." },
};

// Motivo só vale pro marco em que foi registrado — cliente que avançou (e
// atrasou de novo em outro marco) precisa de um motivo novo.
function motivoAtrasoAtual(c) {
  const m = c && c.motivo_atraso;
  return m && m.marco === c.etapa && MOTIVOS_ATRASO[m.motivo] ? m : null;
}

// "Implantação parada": nenhuma atividade (acontecimento na linha do tempo ou
// salvamento do checklist de marcos) há mais de N dias. Cliente novo sem
// nenhum registro conta a partir da data de entrada.
const DIAS_IMPLANTACAO_PARADA = 15;

function diasSemAtividade(c) {
  const ultima = [c.ultima_acao_data, c.marcos_atualizado_em, c.data_entrada]
    .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d || ""))
    .map((d) => d.slice(0, 10))
    .sort()
    .pop();
  return ultima ? diasDesdeEntrada(ultima) : null;
}

// Dias entre duas datas ISO (YYYY-MM-DD); null se alguma for inválida.
function diasEntre(inicioIso, fimIso) {
  const ini = diasDesdeEntrada(inicioIso);
  const fim = diasDesdeEntrada(fimIso);
  return ini === null || fim === null ? null : ini - fim;
}

function clienteParado(c) {
  if (!c || c.etapa === "concluido") return false;
  const dias = diasSemAtividade(c);
  return dias !== null && dias > DIAS_IMPLANTACAO_PARADA;
}

const ICONES_CARD_MARCOS = {
  calendario: '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  caminhao: '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
  pessoa: '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
};

function linhaCardMarcos(icone, html) {
  const linha = document.createElement("div");
  linha.className = "kmarcos-card-linha";
  linha.innerHTML = `<span class="kmarcos-card-icone kmarcos-icone-${icone}">${ICONES_CARD_MARCOS[icone]}</span>`;
  const texto = document.createElement("span");
  if (html instanceof Node) texto.appendChild(html); else texto.textContent = html;
  linha.appendChild(texto);
  return linha;
}

function montarCardMarcos(c) {
  const card = document.createElement("div");
  card.className = "kmarcos-card";
  if (clientePossivelRisco(c)) {
    card.classList.add("kmarcos-card-risco");
    card.title = "Possível risco: mais de 60 dias de casa e menos de 30 placas";
  }
  card.addEventListener("click", () => abrirClienteOuFicha(c, abrirTimelineImplantacao));

  const nome = document.createElement("div");
  nome.className = "kmarcos-card-nome";
  nome.textContent = c.cliente || c.idcentral || "(sem nome)";
  card.appendChild(nome);

  const linhaStatus = document.createElement("div");
  linhaStatus.className = "kmarcos-card-status";
  const corFlag = FLAG_ICONE_COR[c.flag];
  if (corFlag) {
    const flag = document.createElement("span");
    flag.className = `kmarcos-card-flag kmarcos-flag-${c.flag.split(" ")[0].toLowerCase()}`;
    flag.innerHTML = '<svg viewBox="0 0 24 24" width="9" height="9" fill="currentColor"><path d="M5 3v18h2v-7h11l-3-4 3-4H7V3z"/></svg>';
    flag.appendChild(document.createTextNode(c.flag));
    linhaStatus.appendChild(flag);
  }
  const atrasado = clienteAtrasadoNoMarco(c);
  const selo = document.createElement("span");
  selo.className = `kmarcos-selo ${atrasado ? "kmarcos-selo-atrasado" : "kmarcos-selo-ok"}`;
  selo.textContent = atrasado ? "Atrasado" : "No prazo";
  if (atrasado) {
    const motivo = motivoAtrasoAtual(c);
    selo.title = motivo ? `Motivo: ${MOTIVOS_ATRASO[motivo.motivo].rotulo}` : "Motivo do atraso não registrado";
  }
  linhaStatus.appendChild(selo);
  if (clienteParado(c)) {
    const parado = document.createElement("span");
    parado.className = "kmarcos-selo kmarcos-selo-parado";
    parado.textContent = `Parado ${diasSemAtividade(c)}d`;
    parado.title = `Sem atividade há ${diasSemAtividade(c)} dias (acontecimentos ou checklist de marcos)`;
    linhaStatus.appendChild(parado);
  }
  card.appendChild(linhaStatus);

  // Entrada e placas dividem a mesma linha (card mais baixo = mais cards
  // visíveis por coluna).
  const linhaDados = document.createElement("div");
  linhaDados.className = "kmarcos-card-linha-dupla";
  const dataBR = formatarDataBRSimples(c.data_entrada);
  if (dataBR) {
    const frag = document.createElement("span");
    const forte = document.createElement("strong");
    forte.textContent = dataBR;
    frag.appendChild(forte);
    const dias = diasDesdeEntrada(c.data_entrada);
    if (dias !== null) {
      const d = document.createElement("span");
      d.className = "kmarcos-card-apagado";
      d.textContent = ` (${dias}d)`;
      frag.appendChild(d);
    }
    linhaDados.appendChild(linhaCardMarcos("calendario", frag));
  }

  const placas = placasCliente(c);
  if (placas !== null) {
    const frag = document.createElement("span");
    const forte = document.createElement("strong");
    forte.textContent = String(placas);
    frag.appendChild(forte);
    linhaDados.appendChild(linhaCardMarcos("caminhao", frag));
  }
  if (linhaDados.childElementCount) card.appendChild(linhaDados);

  card.appendChild(linhaCardMarcos("pessoa", c.csm || "Sem responsável"));
  return card;
}

function construirKanbanMarcos(clientes) {
  const board = document.createElement("div");
  board.className = "kmarcos-board";
  IMPLANTACAO_MARCOS.forEach((marco) => {
    const doMarco = clientes.filter((c) => (c.etapa || "marco-1") === marco);
    const coluna = document.createElement("div");
    coluna.className = "kmarcos-coluna";

    // Cabeçalho em 2 linhas: "Marco 1 (7 dias)" + contagem à direita; nome
    // do marco + placas embaixo.
    const cabecalho = document.createElement("div");
    cabecalho.className = "kmarcos-coluna-cabecalho";
    const linhaTitulo = document.createElement("div");
    linhaTitulo.className = "kmarcos-coluna-linha";
    const titulo = document.createElement("h2");
    titulo.className = "kmarcos-coluna-titulo";
    titulo.textContent = IMPLANTACAO_ETAPA_LABELS[marco];
    const contagem = document.createElement("span");
    contagem.className = "kmarcos-coluna-contagem";
    contagem.textContent = String(doMarco.length);
    contagem.title = `${doMarco.length} ${doMarco.length === 1 ? "cliente" : "clientes"}`;
    linhaTitulo.appendChild(titulo);
    linhaTitulo.appendChild(contagem);
    cabecalho.appendChild(linhaTitulo);
    const info = IMPLANTACAO_MARCOS_INFO[marco];
    const totalPlacas = doMarco.reduce((soma, c) => soma + (placasCliente(c) || 0), 0);
    const sub = document.createElement("div");
    sub.className = "kmarcos-coluna-sub";
    sub.textContent = `${info ? `${info.nome} · ` : ""}${totalPlacas} placas`;
    sub.title = sub.textContent;
    cabecalho.appendChild(sub);
    coluna.appendChild(cabecalho);

    const lista = document.createElement("div");
    lista.className = "kmarcos-coluna-cards";
    if (doMarco.length === 0) {
      const vazio = document.createElement("div");
      vazio.className = "kmarcos-vazio";
      vazio.textContent = "Nenhum cliente neste marco";
      lista.appendChild(vazio);
    }
    doMarco.forEach((c) => lista.appendChild(montarCardMarcos(c)));
    coluna.appendChild(lista);
    board.appendChild(coluna);
  });
  return board;
}

// Barra de números acima do Kanban. Conta sobre os clientes em andamento já
// filtrados por busca/CSM (mas antes do filtro da própria barra, senão os
// outros blocos zeravam). Clicar num bloco filtra; clicar de novo desfaz.
function construirBarraStatsMarcos(clientes, aoMudarFiltro) {
  const barra = document.createElement("div");
  barra.className = "kmarcos-stats";

  function bloco(rotulo, valor, classe, ativo, aoClicar, iconeFlag) {
    const b = document.createElement(aoClicar ? "button" : "div");
    if (aoClicar) b.type = "button";
    b.className = `kmarcos-stat ${classe}${ativo ? " ativo" : ""}`;
    const r = document.createElement("span");
    r.className = "kmarcos-stat-rotulo";
    if (iconeFlag) r.innerHTML = '<svg viewBox="0 0 24 24" width="9" height="9" fill="currentColor"><path d="M5 3v18h2v-7h11l-3-4 3-4H7V3z"/></svg>';
    r.appendChild(document.createTextNode(rotulo));
    const v = document.createElement("span");
    v.className = "kmarcos-stat-valor";
    v.textContent = String(valor);
    b.appendChild(r);
    b.appendChild(v);
    if (aoClicar) b.addEventListener("click", aoClicar);
    barra.appendChild(b);
  }

  const atrasados = clientes.filter(clienteAtrasadoNoMarco).length;
  bloco("Total", clientes.length, "kmarcos-stat-total", false, null);
  bloco("No prazo", clientes.length - atrasados, "kmarcos-stat-ok", implantacaoFiltroStatus === "ok", () => {
    implantacaoFiltroStatus = implantacaoFiltroStatus === "ok" ? "" : "ok";
    aoMudarFiltro();
  });
  bloco("Atrasados", atrasados, "kmarcos-stat-atrasado", implantacaoFiltroStatus === "atrasado", () => {
    implantacaoFiltroStatus = implantacaoFiltroStatus === "atrasado" ? "" : "atrasado";
    aoMudarFiltro();
  });
  bloco("Parados", clientes.filter(clienteParado).length, "kmarcos-stat-parado", implantacaoFiltroParado, () => {
    implantacaoFiltroParado = !implantacaoFiltroParado;
    aoMudarFiltro();
  });
  ["Yellow Flag", "Red Flag", "Black Flag"].forEach((flag) => {
    const qtd = clientes.filter((c) => c.flag === flag).length;
    bloco(flag.replace(" Flag", ""), qtd, `kmarcos-stat-flag kmarcos-flag-${flag.split(" ")[0].toLowerCase()}`, implantacaoFiltroFlag === flag, () => {
      implantacaoFiltroFlag = implantacaoFiltroFlag === flag ? "" : flag;
      aoMudarFiltro();
    }, true);
  });
  return barra;
}

// --- MODAL "IMPLANTADOS" (concluíram os 5 marcos) ---
const overlayImplantados = el("overlay-implantados");
const implantadosTitulo = el("implantados-titulo");
const implantadosBusca = el("implantados-busca");
const implantadosLista = el("implantados-lista");

function clientesImplantados() {
  return implantacaoClientesCache.filter((c) => c.etapa === "concluido");
}

function renderizarListaImplantados() {
  const filtro = implantadosBusca.value.trim().toLowerCase();
  const todos = clientesImplantados();
  // Mais recente primeiro; quem concluiu antes da data começar a ser gravada
  // (sem concluido_em) vai pro fim, em ordem alfabética.
  const lista = todos
    .filter((c) => !filtro || (c.cliente || "").toLowerCase().includes(filtro) || (c.idcentral || "").toLowerCase().includes(filtro))
    .sort((a, b) => {
      const da = a.concluido_em || "";
      const db = b.concluido_em || "";
      if (da !== db) return db.localeCompare(da);
      return (a.cliente || "").localeCompare(b.cliente || "", "pt-BR");
    });
  implantadosTitulo.textContent = `Clientes implantados (${todos.length})`;
  implantadosLista.innerHTML = "";

  if (lista.length === 0) {
    const vazio = document.createElement("p");
    vazio.className = "kmarcos-vazio";
    vazio.textContent = todos.length === 0 ? "Nenhum cliente concluiu os 5 marcos ainda." : "Nenhum cliente encontrado com esse filtro.";
    implantadosLista.appendChild(vazio);
    return;
  }

  const table = document.createElement("table");
  table.className = "tabela-saida tabela-implantados";
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  ["IdCentral", "Cliente", "Responsável", "Data de implantação"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  lista.forEach((c) => {
    const tr = document.createElement("tr");
    tr.className = "tabela-implantados-linha";
    const dataBR = formatarDataBRSimples(c.concluido_em);
    [c.idcentral || "-", c.cliente || "(sem nome)", c.csm || "-", dataBR || "sem data registrada"].forEach((valor, i) => {
      const td = document.createElement("td");
      td.textContent = valor;
      if (i === 3 && !dataBR) td.className = "kmarcos-card-apagado";
      tr.appendChild(td);
    });
    tr.addEventListener("click", () => {
      overlayImplantados.classList.add("hidden");
      abrirClienteOuFicha(c, abrirTimelineImplantacao);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  implantadosLista.appendChild(table);
}

function abrirModalImplantados() {
  implantadosBusca.value = "";
  renderizarListaImplantados();
  overlayImplantados.classList.remove("hidden");
  implantadosBusca.focus();
}

implantadosBusca.addEventListener("input", renderizarListaImplantados);
el("implantados-fechar").addEventListener("click", () => overlayImplantados.classList.add("hidden"));

async function carregarImplantacaoClientes() {
  mostrarPlaceholder("Carregando clientes em implantação...");
  try {
    const r = await fetch("/api/clientes");
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErro(data.error || "Falha ao carregar.");
    implantacaoClientesCache = data.clientes || [];
    // Mesma lista serve pra busca global da topbar (sem ler de novo).
    buscaGlobalClientes = implantacaoClientesCache;
    await mostrarTabelaImplantacaoClientes();
  } catch (err) {
    mostrarErro(String(err));
  }
}

function formatarMoedaBRL(valor) {
  return (Number(valor) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatarDataBRSimples(iso) {
  const partes = String(iso || "").split("-");
  if (partes.length !== 3) return null;
  const [ano, mes, dia] = partes;
  return `${dia}/${mes}/${ano}`;
}

// Largura da coluna Objetivo, ajustável arrastando a alça no cabeçalho —
// guardada no navegador (localStorage) pra continuar do jeito que a pessoa deixou.
let implantacaoLarguraObjetivo = Number(localStorage.getItem("implantacaoLarguraObjetivo")) || 208;

function iniciarResizeObjetivo(e, th, tds) {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = th.offsetWidth;

  function aoMover(ev) {
    const novaLargura = Math.max(100, startWidth + (ev.clientX - startX));
    th.style.width = `${novaLargura}px`;
    tds.forEach((td) => { td.style.width = `${novaLargura}px`; });
  }
  function aoSoltar() {
    document.removeEventListener("mousemove", aoMover);
    document.removeEventListener("mouseup", aoSoltar);
    implantacaoLarguraObjetivo = th.offsetWidth;
    localStorage.setItem("implantacaoLarguraObjetivo", String(implantacaoLarguraObjetivo));
  }
  document.addEventListener("mousemove", aoMover);
  document.addEventListener("mouseup", aoSoltar);
}

// Monta só o <table>, sem tocar na barra de busca — assim o campo de busca
// nunca é recriado a cada tecla digitada (senão perde o foco/cursor).
// ordemClienteDir/onClickOrdenarCliente controlam a ordenação A-Z da coluna Cliente
// (a ordem padrão da lista continua sendo por Última ação, vinda do backend).
function construirTabelaImplantacao(clientes, mensagemVazia, ordemClienteDir, onClickOrdenarCliente) {
  const headers = ["IdCentral", "Cliente", "Data de entrada", "Objetivo", "Valor de contrato", "Última ação", "Etapa", "Responsável", ""];
  const table = document.createElement("table");
  table.className = "tabela-saida tabela-implantacao-clientes";

  const thObjetivoTds = [];
  let thObjetivo = null;

  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    if (h === "Cliente") {
      th.className = "th-ordenavel";
      if (ordemClienteDir) {
        const seta = document.createElement("span");
        seta.className = "seta-ordenacao";
        seta.textContent = ordemClienteDir === 1 ? " ▲" : " ▼";
        th.appendChild(seta);
      }
      th.addEventListener("click", onClickOrdenarCliente);
    }
    if (h === "Objetivo") {
      th.classList.add("th-redimensionavel");
      th.style.width = `${implantacaoLarguraObjetivo}px`;
      const alca = document.createElement("span");
      alca.className = "col-resize-handle";
      alca.title = "Arraste para redimensionar";
      alca.addEventListener("mousedown", (e) => iniciarResizeObjetivo(e, thObjetivo, thObjetivoTds));
      th.appendChild(alca);
      thObjetivo = th;
    }
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  if (clientes.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = headers.length;
    td.textContent = mensagemVazia;
    td.style.color = "#6b7280";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  clientes.forEach((c) => {
    const tr = document.createElement("tr");
    tr.className = "linha-clicavel";
    tr.title = "Clique para ver a linha do tempo";
    tr.addEventListener("click", () => abrirClienteOuFicha(c, abrirTimelineImplantacao));
    const etapaLabel = IMPLANTACAO_ETAPA_LABELS[c.etapa] || IMPLANTACAO_ETAPA_LABELS["marco-1"];
    [c.idcentral, c.cliente, formatarDataBRSimples(c.data_entrada), c.objetivo, formatarMoedaBRL(c.valor_contrato), c.ultima_acao, etapaLabel, c.csm].forEach((v, i) => {
      const td = document.createElement("td");
      td.textContent = v === null || v === undefined || v === "" ? "-" : String(v);
      if (headers[i] === "Objetivo") {
        td.classList.add("td-objetivo-implantacao");
        td.style.width = `${implantacaoLarguraObjetivo}px`;
        thObjetivoTds.push(td);
      }
      tr.appendChild(td);
    });

    const tdAcoes = document.createElement("td");
    tdAcoes.className = "acoes-credencial";

    const btnEditar = document.createElement("button");
    btnEditar.className = "btn-engrenagem";
    btnEditar.classList.add("btn-engrenagem-icone");
    btnEditar.title = "Editar cliente";
    aplicarIconeEngrenagem(btnEditar);
    btnEditar.addEventListener("click", (e) => {
      e.stopPropagation();
      abrirModalImplantacaoCliente(c);
    });
    tdAcoes.appendChild(btnEditar);

    const btnExcluir = document.createElement("button");
    btnExcluir.className = "btn-engrenagem btn-excluir";
    btnExcluir.textContent = "🗑";
    btnExcluir.title = "Excluir cliente";
    btnExcluir.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Excluir o cliente "${c.cliente}" da implantação?`)) return;
      try {
        const r = await fetch(`/api/clientes/${c.id}`, { method: "DELETE" });
        const data = await parseJsonResponse(r);
        if (!data.ok) return mostrarErro(data.error || "Falha ao excluir.");
        await carregarImplantacaoClientes();
      } catch (err) {
        mostrarErro(String(err));
      }
    });
    tdAcoes.appendChild(btnExcluir);

    tr.appendChild(tdAcoes);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

async function mostrarTabelaImplantacaoClientes() {
  const wrapper = document.createElement("div");
  wrapper.className = "saida-view";

  const toolbar = document.createElement("div");
  toolbar.className = "migracao-toolbar implantacao-toolbar saida-view-toolbar";

  const btnAdicionar = document.createElement("button");
  btnAdicionar.className = "btn-primary";
  btnAdicionar.textContent = "+ Adicionar cliente";
  btnAdicionar.addEventListener("click", () => abrirModalImplantacaoCliente(null));
  toolbar.appendChild(btnAdicionar);

  const btnImportarPlanilha = document.createElement("button");
  btnImportarPlanilha.className = "btn-secondary";
  btnImportarPlanilha.textContent = "Importar planilha";
  btnImportarPlanilha.addEventListener("click", () => abrirModalImportarClientes());
  toolbar.appendChild(btnImportarPlanilha);

  // Filtro local (só esconde cards/linhas desta tela) — diferente da busca da
  // topbar, que é "ir para o cliente" e abre a Ficha.
  toolbar.appendChild(criarCampoFiltroLista(implantacaoFiltroTexto, (valor) => {
    implantacaoFiltroTexto = valor;
    atualizarConteudo();
  }));

  const selectFiltroCsm = document.createElement("select");
  selectFiltroCsm.className = "implantacao-filtro-csm";
  const optTodos = document.createElement("option");
  optTodos.value = "";
  optTodos.textContent = "Todos os CSMs";
  selectFiltroCsm.appendChild(optTodos);
  (await buscarUsuariosOpcoes("area_prefix=CS")).forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.nome;
    opt.textContent = u.nome;
    selectFiltroCsm.appendChild(opt);
  });
  selectFiltroCsm.value = implantacaoFiltroCsm;
  toolbar.appendChild(selectFiltroCsm);

  const segView = document.createElement("div");
  segView.className = "segmentado";
  const btnViewKanban = document.createElement("button");
  btnViewKanban.type = "button";
  btnViewKanban.textContent = "Kanban";
  const btnViewLista = document.createElement("button");
  btnViewLista.type = "button";
  btnViewLista.textContent = "Lista";
  segView.appendChild(btnViewKanban);
  segView.appendChild(btnViewLista);
  toolbar.appendChild(segView);

  const btnImplantados = document.createElement("button");
  btnImplantados.type = "button";
  btnImplantados.className = "btn-secondary btn-ver-implantados";
  btnImplantados.textContent = `✓ Implantados (${clientesImplantados().length})`;
  btnImplantados.addEventListener("click", abrirModalImplantados);
  toolbar.appendChild(btnImplantados);

  wrapper.appendChild(toolbar);

  const tabelaContainer = document.createElement("div");
  tabelaContainer.className = "saida-view-corpo";
  wrapper.appendChild(tabelaContainer);

  let ordemClienteDir = null; // null = ordem padrão (Última ação); 1 = A-Z; -1 = Z-A

  function clientesFiltrados() {
    const filtro = normalizarBusca(implantacaoFiltroTexto);
    // Cliente criado pela tela de Migração sem par na Implantação
    // (tem_implantacao=false) não aparece aqui — ele não passou por nenhum
    // marco, não tem o que mostrar nesse Kanban. implantacaoClientesCache
    // continua completo (sem esse filtro) pra busca global da topbar achar
    // esse cliente e cair na Ficha dele.
    let filtrados = implantacaoClientesCache.filter((c) => c.tem_implantacao !== false);
    if (filtro) {
      filtrados = filtrados.filter((c) => normalizarBusca(`${c.cliente || ""} ${c.idcentral || ""}`).includes(filtro));
    }
    if (implantacaoFiltroCsm) {
      filtrados = filtrados.filter((c) => c.csm === implantacaoFiltroCsm);
    }
    return filtrados;
  }

  function atualizarConteudo() {
    tabelaContainer.innerHTML = "";
    if (implantacaoView === "kanban") {
      const emAndamento = clientesFiltrados().filter((c) => c.etapa !== "concluido");
      let noBoard = emAndamento;
      if (implantacaoFiltroStatus) {
        noBoard = noBoard.filter((c) => clienteAtrasadoNoMarco(c) === (implantacaoFiltroStatus === "atrasado"));
      }
      if (implantacaoFiltroFlag) noBoard = noBoard.filter((c) => c.flag === implantacaoFiltroFlag);
      if (implantacaoFiltroParado) noBoard = noBoard.filter(clienteParado);
      const wrapKanban = document.createElement("div");
      wrapKanban.className = "kmarcos-wrap";
      wrapKanban.appendChild(construirBarraStatsMarcos(emAndamento, atualizarConteudo));
      wrapKanban.appendChild(construirKanbanMarcos(noBoard));
      tabelaContainer.appendChild(wrapKanban);
    } else {
      let filtrados = clientesFiltrados();
      if (ordemClienteDir) {
        filtrados = filtrados
          .slice()
          .sort((a, b) => (a.cliente || "").localeCompare(b.cliente || "", "pt-BR") * ordemClienteDir);
      }
      const mensagemVazia = implantacaoClientesCache.length === 0
        ? "Nenhum cliente em implantação ainda."
        : "Nenhum cliente encontrado com esse filtro.";
      tabelaContainer.appendChild(
        construirTabelaImplantacao(filtrados, mensagemVazia, ordemClienteDir, () => {
          ordemClienteDir = ordemClienteDir === 1 ? -1 : 1;
          atualizarConteudo();
        })
      );
    }
    btnViewKanban.classList.toggle("ativo", implantacaoView === "kanban");
    btnViewLista.classList.toggle("ativo", implantacaoView === "lista");
  }

  selectFiltroCsm.addEventListener("change", () => {
    implantacaoFiltroCsm = selectFiltroCsm.value;
    atualizarConteudo();
  });

  btnViewKanban.addEventListener("click", () => { implantacaoView = "kanban"; atualizarConteudo(); });
  btnViewLista.addEventListener("click", () => { implantacaoView = "lista"; atualizarConteudo(); });

  atualizarConteudo();
  setSaida(wrapper);
}

// Busca a lista enxuta de usuários (Gerenciar Usuários) filtrada por área —
// "area=Comercial" (exato) ou "area_prefix=CS" (casa CS - Implantação/
// Onboarding/Ongoing, qualquer uma delas pode ter carteira própria).
async function buscarUsuariosOpcoes(queryString) {
  try {
    const r = await fetch(`/api/app-usuarios/opcoes?${queryString}`);
    const data = await parseJsonResponse(r);
    return data.ok ? (data.usuarios || []) : [];
  } catch (err) {
    return [];
  }
}

// Popula um <select> (Consultor Comercial, Responsável) com os usuários da
// área pedida. Valor já salvo (texto livre, de antes desses campos virarem
// lista, ou gente que saiu da área) que não bate com ninguém da lista entra
// como opção extra — pra não sumir dado existente.
async function popularSelectUsuariosPorArea(select, valorAtual, queryString) {
  select.innerHTML = '<option value="">Selecione...</option>';
  const usuarios = await buscarUsuariosOpcoes(queryString);
  usuarios.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.nome;
    opt.textContent = u.nome;
    select.appendChild(opt);
  });
  if (valorAtual && !Array.from(select.options).some((o) => o.value === valorAtual)) {
    const opt = document.createElement("option");
    opt.value = valorAtual;
    opt.textContent = `${valorAtual} (fora da lista)`;
    select.appendChild(opt);
  }
  select.value = valorAtual || "";
}

async function abrirModalImplantacaoCliente(cliente) {
  // Sidebar (Implantação/Migração, troca de modal) só aparece quando o
  // contexto de Ficha é realmente deste mesmo cliente — evita usar um
  // contexto antigo/de outro cliente que tenha ficado em memória. Os marcos
  // não ficam mais aqui: são a aba "Marcos" da Ficha.
  const contextoFichaValido = !!(fichaConfigContexto && cliente
    && fichaConfigContexto.implantacao.id === cliente.id);
  implantacaoClienteSidebarConfig.classList.toggle("hidden", !contextoFichaValido);
  modalImplantacaoClienteEl.classList.toggle("tem-sidebar-config", contextoFichaValido);
  implantacaoClienteSidebarConfig.querySelector('[data-aba="migracao"]').classList.toggle(
    "hidden", !contextoFichaValido || !fichaConfigContexto.migracao
  );
  implantacaoClienteSidebarConfig.querySelector('[data-aba="credenciais"]').classList.toggle("hidden", !contextoFichaValido);
  implantacaoClienteSidebarConfig.querySelectorAll('.modal-sidebar-config-item').forEach((b) => {
    b.classList.remove("ativo");
  });
  if (cliente) {
    implantacaoClienteSidebarConfig.querySelector('[data-aba="implantacao"]').classList.add("ativo");
  }
  implantacaoClienteEditandoId = cliente ? cliente.id : null;
  implantacaoClienteEmEdicao = cliente;
  mostrarFormularioCliente();
  implantacaoClienteModalTitulo.textContent = cliente ? "Editar cliente" : "Adicionar cliente";
  inputImplantacaoClienteIdcentral.value = cliente ? cliente.idcentral || "" : "";
  // Só admin altera o IdCentral de um cliente já existente (é ele que liga
  // Implantação e Migração); num cliente novo, quem estiver criando pode
  // preencher normalmente.
  const idcentralTravadoImpl = !!cliente && USUARIO_PERFIL_ATUAL !== "adm";
  inputImplantacaoClienteIdcentral.disabled = idcentralTravadoImpl;
  inputImplantacaoClienteIdcentral.title = idcentralTravadoImpl ? "Só administradores podem alterar o IdCentral." : "";
  inputImplantacaoClienteNome.value = cliente ? cliente.cliente : "";
  inputImplantacaoClienteData.value = cliente ? cliente.data_entrada || "" : "";
  await popularSelectUsuariosPorArea(inputImplantacaoClienteCsm, cliente ? cliente.csm || "" : "", "area_prefix=CS");
  btnSalvarImplantacaoCliente.textContent = cliente ? "Salvar edição" : "Adicionar";

  // Cadastro rápido (criar) só mostra o essencial; campos complementares só
  // aparecem editando um cliente já existente (Editar/Configurar Cliente).
  wrapImplantacaoClienteComplementares.classList.toggle("hidden", !cliente);
  atualizarCampoImplantado(cliente);
  inputImplantacaoClienteObjetivo.value = cliente ? cliente.objetivo || "" : "";
  inputImplantacaoClienteValor.value = cliente && cliente.valor_contrato ? cliente.valor_contrato : "";
  inputImplantacaoClienteMomento.value = cliente ? cliente.momento || "" : "";
  inputImplantacaoClienteFlag.value = cliente ? cliente.flag || "" : "";
  await popularSelectUsuariosPorArea(inputImplantacaoClienteVendedor, cliente ? cliente.vendedor || "" : "", "area=Comercial");
  inputImplantacaoClientePersona.value = cliente ? cliente.persona || "" : "";
  inputImplantacaoClienteDecisorNome.value = cliente ? cliente.decisor_nome || "" : "";
  inputImplantacaoClienteDecisorWhatsapp.value = cliente ? cliente.decisor_whatsapp || "" : "";
  comboDecisorEstado.limpar();
  comboDecisorCidade.limpar();
  comboDecisorCidade.input.disabled = true;
  comboDecisorCidade.input.placeholder = "Escolha o estado primeiro";

  // Migração é uma condição à parte do cliente (não uma etapa) — só esse campo
  // (Sim/Não) trava quando já há uma ativa: não dá pra "excluir" a migração
  // pelo cadastro — cancelar e editar detalhes (plataforma, planilha, etc.) é
  // só em Configurações de Migração (sidebar da Ficha, engrenagem > Migração).
  implantacaoClienteMigracaoAtual = null;
  inputImplantacaoClienteTemMigracao.value = "nao";
  inputImplantacaoClienteTemMigracao.disabled = false;
  inputImplantacaoClienteTemMigracao.title = "";

  // Mostra o modal JÁ (síncrono) — a checagem de migração em andamento roda
  // em seguida, em segundo plano, só refinando o toggle quando chegar. Buscar
  // isso antes de exibir o modal é o que causava o "abre e fecha" ao navegar
  // pelo sidebar da Ficha (o modal ficava esperando a resposta pra aparecer).
  overlayImplantacaoCliente.classList.remove("hidden");
  inputImplantacaoClienteNome.focus();

  if (cliente) {
    try {
      const r = await fetch(`/api/clientes/${cliente.id}/migracoes`);
      const data = await parseJsonResponse(r);
      const atual = data.ok ? (data.migracoes || []).find((m) => m.status === "em_andamento") : null;
      if (atual) {
        implantacaoClienteMigracaoAtual = atual;
        inputImplantacaoClienteTemMigracao.value = "sim";
        inputImplantacaoClienteTemMigracao.disabled = true;
        inputImplantacaoClienteTemMigracao.title = "Migração já em andamento — pra cancelar ou editar detalhes, use Configurações de Migração.";
      }
    } catch (err) {
      // silencioso: não bloqueia a edição do cliente por falha nessa consulta
    }

    // Estado/Cidade do Decisor — carrega em segundo plano, igual à checagem
    // de migração acima (o modal já está visível, isso só popula os campos).
    await carregarEstadosBrasil();
    if (cliente.decisor_estado) {
      comboDecisorEstado.setValor(cliente.decisor_estado);
      await carregarMunicipiosDoEstado(cliente.decisor_estado, cliente.decisor_cidade || "");
    }
  }
}

el("implantacao-cliente-modal-fechar").addEventListener("click", () => {
  overlayImplantacaoCliente.classList.add("hidden");
  fichaConfigContexto = null;
});
implantacaoClienteSidebarConfig.querySelectorAll(".modal-sidebar-config-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    // "Implantação" é este próprio formulário; "Migração" troca de modal via
    // o mecanismo de Configurações da Ficha. (Marcos saiu do modal — virou a
    // aba "Marcos" da Ficha.)
    if (btn.dataset.aba === "implantacao") {
      mostrarFormularioCliente();
    } else {
      mostrarConfigFichaAba(btn.dataset.aba);
    }
  });
});

formImplantacaoCliente.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    idcentral: inputImplantacaoClienteIdcentral.value.trim(),
    cliente: inputImplantacaoClienteNome.value.trim(),
    data_entrada: inputImplantacaoClienteData.value,
    objetivo: inputImplantacaoClienteObjetivo.value.trim(),
    valor_contrato: inputImplantacaoClienteValor.value,
    csm: inputImplantacaoClienteCsm.value.trim(),
    momento: inputImplantacaoClienteMomento.value,
    flag: inputImplantacaoClienteFlag.value,
    vendedor: inputImplantacaoClienteVendedor.value.trim(),
    persona: inputImplantacaoClientePersona.value,
    decisor_nome: inputImplantacaoClienteDecisorNome.value.trim(),
    decisor_whatsapp: inputImplantacaoClienteDecisorWhatsapp.value.trim(),
    decisor_estado: comboDecisorEstado.valor,
    decisor_cidade: comboDecisorCidade.valor || comboDecisorCidade.input.value.trim(),
  };
  if (!payload.idcentral) return alert("Informe o IdCentral do cliente.");
  // Trava o botão enquanto salva — duplo clique mandava dois POSTs e podia
  // criar o mesmo cliente duas vezes (o backend também barra, com lock).
  if (btnSalvarImplantacaoCliente.disabled) return;
  btnSalvarImplantacaoCliente.disabled = true;
  try {
    const url = implantacaoClienteEditandoId
      ? `/api/clientes/${implantacaoClienteEditandoId}`
      : "/api/clientes";
    const method = implantacaoClienteEditandoId ? "PUT" : "POST";
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao salvar: ${data.error || "falha desconhecida"}`);

    // "Tem Migração?" — só inicia uma tentativa nova quando marcou "Sim" e não
    // tinha nenhuma em andamento ainda. Se já tinha uma ativa, o campo veio
    // travado (disabled) lá em abrirModalImplantacaoCliente — não mexe em nada
    // aqui; cancelar é ação própria, feita na Ficha (Configurações de Migração).
    const clienteId = data.cliente.id;
    const querMigracaoNova = !implantacaoClienteMigracaoAtual && inputImplantacaoClienteTemMigracao.value === "sim";
    if (querMigracaoNova) {
      try {
        await fetch(`/api/clientes/${clienteId}/migracoes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch (err) {
        alert(`Cliente salvo, mas houve erro ao iniciar a migração: ${String(err)}`);
      }
    }

    overlayImplantacaoCliente.classList.add("hidden");
    fichaConfigContexto = null;

    // Se veio da Ficha (editando o cliente que ela já está mostrando), volta
    // pra Ficha atualizada em vez de voltar pro Kanban — mesmo racional do
    // painel de Configurações de Migração.
    const clienteFichaAberta = fichaClienteAtual && fichaClienteAtual.implantacao
      && fichaClienteAtual.implantacao.id === implantacaoClienteEditandoId;
    if (clienteFichaAberta) {
      // Usa o idcentral recém-salvo (não o antigo em cache) — cobre o caso raro
      // de um admin trocar o IdCentral durante essa mesma edição.
      await carregarFichaCliente(data.cliente.idcentral);
    } else {
      await carregarImplantacaoClientes();
    }
  } catch (err) {
    alert(`Erro ao salvar: ${String(err)}`);
  } finally {
    btnSalvarImplantacaoCliente.disabled = false;
  }
});

// --- MARCOS DA IMPLANTAÇÃO (checklist, com prazo/atrasado) ---
// "concluido" fica de fora — é o estado derivado quando os 5 abaixo estão
// marcados, calculado no backend (PUT /api/clientes/<id>/marcos).
const IMPLANTACAO_MARCOS = ["marco-1", "marco-2", "marco-3", "marco-4", "marco-5"];
const IMPLANTACAO_MARCO_PRAZOS = { "marco-1": 7, "marco-2": 21, "marco-3": 60, "marco-4": 120, "marco-5": 180 };
// Nome, dono e janela de cada marco (Plano de Sucesso do Cliente — 180 dias).
// Só usado na tela do cliente (modal de Marcos e Ficha) — o Kanban/dashboard
// continuam com IMPLANTACAO_ETAPA_LABELS ("Marco 1 (7 dias)").
const IMPLANTACAO_MARCOS_INFO = {
  "marco-1": { nome: "Setup e Ativação Rápida", dono: "Implantação", inicio: 1 },
  "marco-2": { nome: "Quick Win e Primeiro Valor Percebido", dono: "Implantação", inicio: 8 },
  "marco-3": { nome: "Adoção e Expansão Inicial", dono: "Implantação", inicio: 22 },
  "marco-4": { nome: "Consolidação e Otimização", dono: "Onboarding", inicio: 61 },
  "marco-5": { nome: "Maturação e Advocacia", dono: "Onboarding", inicio: 121 },
};
// Marco onde ficam as prioridades acordadas com o cliente (mesmo do backend).
const IMPLANTACAO_MARCO_PRIORIDADES = "marco-2";

function nomeCompletoMarco(marco) {
  const info = IMPLANTACAO_MARCOS_INFO[marco];
  if (!info) return IMPLANTACAO_ETAPA_LABELS[marco] || marco;
  return `${marco.replace("marco-", "Marco ")} · ${info.nome}`;
}

function marcoAtrasado(dataEntrada, marco, marcosConcluidos) {
  if ((marcosConcluidos || []).includes(marco)) return false;
  const dias = diasDesdeEntrada(dataEntrada);
  return dias !== null && dias > IMPLANTACAO_MARCO_PRAZOS[marco];
}

// Checklist de cada marco = itens padrão (CHECKLIST_MARCOS_PADRAO, definido
// no backend e injetado no template) + itens extras só deste cliente. O
// marco conclui sozinho com todos os itens feitos, ou marcado manualmente.
// Tudo é editado num rascunho em memória e só vai pro servidor no "Salvar
// marcos" — dá pra passar por vários marcos na lista e salvar tudo de uma vez.
const CHECKLIST_MARCOS = window.CHECKLIST_MARCOS_PADRAO || {};
const implantacaoMarcosSubmenu = el("implantacao-marcos-submenu");
const implantacaoMarcoPainel = el("implantacao-marco-painel");
const implantacaoMarcoResumo = el("implantacao-marco-resumo");
const implantacaoMarcoItens = el("implantacao-marco-itens");
const inputImplantacaoMarcoManual = el("implantacao-marco-manual");
const btnSalvarImplantacaoMarcos = el("btn-salvar-implantacao-marcos");
const implantacaoMarcoTitulo = el("implantacao-marco-titulo");
let marcosRascunho = null;
let marcosRascunhoAlterado = false;
let marcoAberto = null;
// Cliente (registro de Implantação da Ficha) cujos marcos estão na tela.
let marcosCliente = null;

function iniciarRascunhoMarcos(cliente) {
  marcosRascunhoAlterado = false;
  marcoAberto = null;
  marcosCliente = cliente;
  if (!cliente) { marcosRascunho = null; return; }
  // Cliente de antes do checklist não tem marcos_concluidos_manual — o
  // progresso antigo (checkbox direto no marco, ou só a etapa da lista
  // suspensa mais antiga ainda) vira conclusão manual, senão salvar
  // "voltaria" o cliente pro Marco 1. Mesma regra do backend.
  let manual = cliente.marcos_concluidos_manual;
  if (!Array.isArray(manual)) {
    manual = cliente.marcos_concluidos || [];
    if (manual.length === 0 && cliente.etapa) {
      const idxEtapa = IMPLANTACAO_MARCOS.indexOf(cliente.etapa);
      manual = idxEtapa > -1 ? IMPLANTACAO_MARCOS.slice(0, idxEtapa)
        : (cliente.etapa === "concluido" ? IMPLANTACAO_MARCOS.slice() : []);
    }
  }
  const extras = {};
  IMPLANTACAO_MARCOS.forEach((m) => {
    extras[m] = ((cliente.marcos_itens_extras || {})[m] || []).map((i) => ({ ...i }));
  });
  marcosRascunho = {
    feitos: new Set(cliente.marcos_itens_feitos || []),
    extras,
    prioridades: (cliente.marcos_prioridades || []).map((p) => ({ ...p, itens: (p.itens || []).map((i) => ({ ...i })) })),
    manual: new Set(manual),
  };
  // Marco salvo como concluído que não fecharia mais pelo checklist atual
  // (a lista padrão mudou depois) vira conclusão manual — senão o próximo
  // "Salvar marcos" reabriria marcos que o cliente já tinha cumprido.
  const concluidosAgora = marcosConcluidosNoRascunho();
  (cliente.marcos_concluidos || []).forEach((m) => {
    if (IMPLANTACAO_MARCOS.includes(m) && !concluidosAgora.includes(m)) marcosRascunho.manual.add(m);
  });
}

function novoIdItemMarco() {
  return `x-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Padrão + extras do cliente (a lista "Checklist do marco" do painel).
function itensChecklistDoMarco(marco) {
  const padrao = (CHECKLIST_MARCOS[marco] || []).map((i) => ({ ...i, extra: false }));
  const extras = (marcosRascunho.extras[marco] || []).map((i) => ({ ...i, extra: true }));
  return padrao.concat(extras);
}

// Tudo que conta pro progresso do marco — no Marco 2 inclui as subtarefas
// das prioridades.
function itensDoMarco(marco) {
  const itens = itensChecklistDoMarco(marco);
  if (marco !== IMPLANTACAO_MARCO_PRIORIDADES) return itens;
  return marcosRascunho.prioridades.flatMap((p) => p.itens).concat(itens);
}

function progressoMarco(marco) {
  const itens = itensDoMarco(marco);
  return { feitos: itens.filter((i) => marcosRascunho.feitos.has(i.id)).length, total: itens.length };
}

function marcosConcluidosNoRascunho() {
  return IMPLANTACAO_MARCOS.filter((marco) => {
    const { feitos, total } = progressoMarco(marco);
    return marcosRascunho.manual.has(marco) || (total > 0 && feitos === total);
  });
}

function dataPrazoMarco(dataEntrada, marco) {
  const [ano, mes, dia] = String(dataEntrada || "").split("-").map(Number);
  if (!ano || !mes || !dia) return null;
  return new Date(ano, mes - 1, dia + IMPLANTACAO_MARCO_PRAZOS[marco]).toLocaleDateString("pt-BR");
}

// Chamado antes de sair da aba Marcos da Ficha (trocar de aba, Voltar) — o
// rascunho dos marcos só existe em memória.
function confirmarDescartarMarcos() {
  if (!marcosRascunhoAlterado) return true;
  if (!confirm("Há alterações nos marcos que ainda não foram salvas. Descartar?")) return false;
  iniciarRascunhoMarcos(marcosCliente);
  return true;
}

function mostrarFormularioCliente() {
  formImplantacaoCliente.classList.remove("hidden");
  implantacaoClienteSidebarConfig.querySelector('[data-aba="implantacao"]').classList.toggle("ativo", !!implantacaoClienteEmEdicao);
  implantacaoClienteModalTitulo.textContent = implantacaoClienteEmEdicao ? "Editar cliente" : "Adicionar cliente";
}

// Aba "Marcos" da Ficha: lista dos 5 marcos à esquerda + checklist do marco
// escolhido à direita. Os dois blocos são nós fixos do template (movidos pra
// cá a cada render da aba), então os listeners ligados no carregamento valem.
function construirFichaMarcos(implantacao, migracao) {
  const wrap = document.createElement("div");
  if (!implantacao) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Esse cliente não tem registro em Implantação.";
    wrap.appendChild(p);
    return wrap;
  }
  // Recarregar a Ficha depois de salvar volta pro mesmo marco que estava aberto.
  const manterMarco = marcosCliente && marcosCliente.id === implantacao.id ? marcoAberto : null;
  iniciarRascunhoMarcos(implantacao);

  const layout = document.createElement("div");
  layout.className = "ficha-marcos-layout";
  const painel = document.createElement("div");
  painel.className = "ficha-painel";
  painel.appendChild(implantacaoMarcoPainel);
  layout.appendChild(implantacaoMarcosSubmenu);
  layout.appendChild(painel);
  wrap.appendChild(layout);

  const etapa = IMPLANTACAO_MARCOS.includes(implantacao.etapa) ? implantacao.etapa : IMPLANTACAO_MARCOS[IMPLANTACAO_MARCOS.length - 1];
  mostrarPainelMarco(manterMarco || etapa);
  return wrap;
}

function mostrarPainelMarco(marco) {
  if (!marcosRascunho) return;
  marcoAberto = marco;
  marcoAdicionando = null;
  renderizarPainelMarco();
}

// Quanto falta pro prazo do marco (ou há quanto está atrasado), contando da
// data de entrada — marco concluído não mostra prazo.
function textoPrazoMarco(dataEntrada, marco, concluidos) {
  if (concluidos.includes(marco)) return null;
  const dias = diasDesdeEntrada(dataEntrada);
  if (dias === null) return null;
  const diff = IMPLANTACAO_MARCO_PRAZOS[marco] - dias;
  const plural = (n) => `${n} dia${n === 1 ? "" : "s"}`;
  if (diff < 0) return { texto: `Atrasado há ${plural(-diff)}`, classe: "atrasado" };
  if (diff === 0) return { texto: "Vence hoje", classe: "atrasado" };
  return { texto: `Faltam ${plural(diff)}`, classe: diff <= 3 ? "perto" : "" };
}

function renderizarSubmenuMarcos() {
  const cliente = marcosCliente;
  const concluidos = marcosConcluidosNoRascunho();
  implantacaoMarcosSubmenu.innerHTML = "";
  IMPLANTACAO_MARCOS.forEach((marco) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "modal-sidebar-subitem";
    btn.classList.toggle("ativo", marco === marcoAberto);

    const nome = document.createElement("span");
    nome.className = "subitem-nome";
    nome.textContent = marco.replace("marco-", "Marco ");
    const info = IMPLANTACAO_MARCOS_INFO[marco];
    if (info) {
      const sub = document.createElement("small");
      sub.textContent = info.nome;
      nome.appendChild(sub);
    }
    const prazo = textoPrazoMarco(cliente.data_entrada, marco, concluidos);
    if (prazo) {
      const linhaPrazo = document.createElement("small");
      linhaPrazo.className = `subitem-prazo ${prazo.classe}`;
      linhaPrazo.textContent = prazo.texto;
      nome.appendChild(linhaPrazo);
    }
    // Data de conclusão (só existe pra marcos concluídos depois que ela
    // passou a ser gravada) + quantos dias após a entrada.
    // Salvo como concluído mas sem data = concluído antes da data começar a
    // ser gravada (ou ainda não salvo, no rascunho).
    const salvoConcluido = (cliente.marcos_concluidos || []).includes(marco);
    if (concluidos.includes(marco)) {
      const dataConclusao = (cliente.marcos_concluidos_em || {})[marco];
      const linhaData = document.createElement("small");
      linhaData.className = "subitem-prazo concluido-em";
      if (dataConclusao) {
        const diasAposEntrada = diasEntre(cliente.data_entrada, dataConclusao);
        linhaData.textContent = `Concluído em ${formatarDataBRSimples(dataConclusao)}`
          + (diasAposEntrada !== null ? ` (dia ${diasAposEntrada})` : "");
      } else {
        linhaData.classList.add("sem-data");
        linhaData.textContent = salvoConcluido ? "Concluído · sem data registrada" : "Concluído · salve para registrar a data";
      }
      nome.appendChild(linhaData);
    }
    const status = document.createElement("span");
    status.className = "subitem-status";
    const { feitos, total } = progressoMarco(marco);
    if (concluidos.includes(marco)) {
      status.textContent = "✓";
      status.classList.add("concluido");
    } else {
      status.textContent = `${feitos}/${total}`;
      if (marcoAtrasado(cliente.data_entrada, marco, concluidos)) {
        status.classList.add("atrasado");
        btn.title = "Atrasado";
      }
    }
    btn.appendChild(nome);
    btn.appendChild(status);
    btn.addEventListener("click", () => mostrarPainelMarco(marco));
    implantacaoMarcosSubmenu.appendChild(btn);
  });
}

// Linha de checklist (checkbox + texto); com onRemover, ganha o "×" — o
// callback só tira o item da lista dele, o resto (feitos/rascunho/render) é aqui.
function criarLinhaItemMarco(item, onRemover) {
  const linha = document.createElement("label");
  linha.className = "marco-linha";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = marcosRascunho.feitos.has(item.id);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) marcosRascunho.feitos.add(item.id);
    else marcosRascunho.feitos.delete(item.id);
    marcosRascunhoAlterado = true;
    renderizarPainelMarco();
  });

  const nome = document.createElement("span");
  nome.textContent = item.texto;
  if (checkbox.checked) linha.classList.add("feito");

  linha.appendChild(checkbox);
  linha.appendChild(nome);

  if (onRemover) {
    const btnRemover = document.createElement("button");
    btnRemover.type = "button";
    btnRemover.className = "btn-remover-item-marco";
    btnRemover.textContent = "×";
    btnRemover.title = "Remover item";
    btnRemover.addEventListener("click", (e) => {
      e.preventDefault();
      onRemover();
      marcosRascunho.feitos.delete(item.id);
      marcosRascunhoAlterado = true;
      renderizarPainelMarco();
    });
    linha.appendChild(btnRemover);
  }
  return linha;
}

// Prioridades da Quick Win (Marco 2): cada cliente tem as dele, combinadas no
// kick-off (ex.: Videotelemetria, Rede CAN), e cada uma tem subtarefas. O
// analista adiciona/renomeia/remove livremente — tudo no rascunho, vai pro
// servidor no "Salvar marcos" junto com o resto.
function construirPrioridadesMarco() {
  const wrap = document.createElement("div");
  wrap.className = "marco-prioridades";

  const titulo = document.createElement("h4");
  titulo.className = "marco-secao-titulo";
  titulo.textContent = "Prioridades acordadas com o cliente";
  wrap.appendChild(titulo);

  if (marcosRascunho.prioridades.length === 0) {
    const vazio = document.createElement("p");
    vazio.className = "placeholder";
    vazio.textContent = "Nenhuma prioridade ainda. Adicione as prioridades combinadas no kick-off (ex.: Videotelemetria).";
    wrap.appendChild(vazio);
  }

  marcosRascunho.prioridades.forEach((prio) => {
    const bloco = document.createElement("div");
    bloco.className = "marco-prioridade";

    const cabecalho = document.createElement("div");
    cabecalho.className = "marco-prioridade-cabecalho";
    const nome = document.createElement("strong");
    nome.textContent = prio.nome;
    const feitos = prio.itens.filter((i) => marcosRascunho.feitos.has(i.id)).length;
    const status = document.createElement("span");
    status.className = "subitem-status";
    if (prio.itens.length > 0 && feitos === prio.itens.length) {
      status.textContent = "✓";
      status.classList.add("concluido");
    } else {
      status.textContent = `${feitos}/${prio.itens.length}`;
    }

    const btnRenomear = document.createElement("button");
    btnRenomear.type = "button";
    btnRenomear.className = "btn-remover-item-marco";
    btnRenomear.textContent = "✎";
    btnRenomear.title = "Renomear prioridade";
    btnRenomear.addEventListener("click", () => {
      const novo = (prompt("Nome da prioridade:", prio.nome) || "").trim();
      if (!novo || novo === prio.nome) return;
      prio.nome = novo.slice(0, 100);
      marcosRascunhoAlterado = true;
      renderizarPainelMarco();
    });

    const btnRemover = document.createElement("button");
    btnRemover.type = "button";
    btnRemover.className = "btn-remover-item-marco";
    btnRemover.textContent = "×";
    btnRemover.title = "Remover prioridade";
    btnRemover.addEventListener("click", () => {
      const aviso = prio.itens.length
        ? `Remover a prioridade "${prio.nome}" e as ${prio.itens.length} subtarefa(s) dela?`
        : `Remover a prioridade "${prio.nome}"?`;
      if (!confirm(aviso)) return;
      prio.itens.forEach((i) => marcosRascunho.feitos.delete(i.id));
      marcosRascunho.prioridades = marcosRascunho.prioridades.filter((p) => p.id !== prio.id);
      marcosRascunhoAlterado = true;
      renderizarPainelMarco();
    });

    cabecalho.appendChild(nome);
    cabecalho.appendChild(status);
    cabecalho.appendChild(btnRenomear);
    cabecalho.appendChild(btnRemover);
    bloco.appendChild(cabecalho);

    prio.itens.forEach((item) => {
      bloco.appendChild(criarLinhaItemMarco(item, () => {
        prio.itens = prio.itens.filter((i) => i.id !== item.id);
      }));
    });

    bloco.appendChild(criarAdicionarInline(`sub:${prio.id}`, "Adicionar subtarefa",
      "Ex.: apontar câmera, criar regras/templates...", 200, (texto) => {
        prio.itens.push({ id: novoIdItemMarco(), texto });
      }));

    wrap.appendChild(bloco);
  });

  wrap.appendChild(criarAdicionarInline("prioridade", "Adicionar prioridade",
    "Ex.: Videotelemetria, Rede CAN...", 100, (nome) => {
      const id = novoIdItemMarco();
      marcosRascunho.prioridades.push({ id, nome, itens: [] });
      // Já abre o campo de subtarefa da prioridade recém-criada.
      return `sub:${id}`;
    }));

  return wrap;
}

// "+ Adicionar ..." que vira um campo só quando clicado — deixa o painel
// limpo. Qual campo está aberto fica em marcoAdicionando (sobrevive aos
// re-renders do painel, ex.: marcar um checkbox com o campo aberto). Enter
// adiciona e mantém o campo aberto pra digitar o próximo; Esc/Cancelar fecha.
// onAdicionar pode devolver a chave de outro campo pra abrir em seguida.
let marcoAdicionando = null;
let marcoAdicionandoTexto = "";

function abrirAdicionarInline(chave) {
  marcoAdicionando = chave;
  marcoAdicionandoTexto = "";
  renderizarPainelMarco();
  const input = implantacaoMarcoItens.querySelector(`input[data-adicionar="${chave}"]`);
  if (input) input.focus();
}

function criarAdicionarInline(chave, rotulo, placeholder, maxLength, onAdicionar) {
  const wrap = document.createElement("div");
  wrap.className = "marco-adicionar";

  if (marcoAdicionando !== chave) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-adicionar-inline";
    btn.textContent = `+ ${rotulo}`;
    btn.addEventListener("click", () => abrirAdicionarInline(chave));
    wrap.appendChild(btn);
    return wrap;
  }

  const form = document.createElement("form");
  form.className = "marco-extra-form";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = maxLength;
  input.placeholder = placeholder;
  input.dataset.adicionar = chave;
  input.value = marcoAdicionandoTexto;
  input.addEventListener("input", () => { marcoAdicionandoTexto = input.value; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      marcoAdicionando = null;
      renderizarPainelMarco();
    }
  });
  const btnOk = document.createElement("button");
  btnOk.type = "submit";
  btnOk.className = "btn-secondary";
  btnOk.textContent = "Adicionar";
  const btnCancelar = document.createElement("button");
  btnCancelar.type = "button";
  btnCancelar.className = "btn-remover-item-marco";
  btnCancelar.textContent = "×";
  btnCancelar.title = "Cancelar";
  btnCancelar.addEventListener("click", () => {
    marcoAdicionando = null;
    renderizarPainelMarco();
  });
  form.appendChild(input);
  form.appendChild(btnOk);
  form.appendChild(btnCancelar);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const texto = input.value.trim();
    if (!texto) return;
    const proxima = onAdicionar(texto);
    marcosRascunhoAlterado = true;
    abrirAdicionarInline(proxima || chave);
  });
  wrap.appendChild(form);
  return wrap;
}

function renderizarPainelMarco() {
  const marco = marcoAberto;
  const cliente = marcosCliente;
  implantacaoMarcoTitulo.textContent = nomeCompletoMarco(marco);

  const { feitos, total } = progressoMarco(marco);
  const concluidos = marcosConcluidosNoRascunho();
  const info = IMPLANTACAO_MARCOS_INFO[marco];
  const partes = [];
  if (info) partes.push(`${info.dono} · dias ${info.inicio}–${IMPLANTACAO_MARCO_PRAZOS[marco]}`);
  partes.push(`${feitos} de ${total} ite${total === 1 ? "m feito" : "ns feitos"}`);
  const prazo = dataPrazoMarco(cliente.data_entrada, marco);
  if (prazo) partes.push(`prazo: ${prazo}`);
  implantacaoMarcoResumo.className = "marco-resumo";
  if (concluidos.includes(marco)) {
    partes.push("Concluído");
    implantacaoMarcoResumo.classList.add("concluido");
  } else if (marcoAtrasado(cliente.data_entrada, marco, concluidos)) {
    partes.push("Atrasado");
    implantacaoMarcoResumo.classList.add("atrasado");
  }
  implantacaoMarcoResumo.textContent = partes.join(" · ");

  implantacaoMarcoItens.innerHTML = "";
  if (marco === IMPLANTACAO_MARCO_PRIORIDADES) {
    implantacaoMarcoItens.appendChild(construirPrioridadesMarco());
    const titulo = document.createElement("h4");
    titulo.className = "marco-secao-titulo";
    titulo.textContent = "Checklist do marco";
    implantacaoMarcoItens.appendChild(titulo);
  }
  const itens = itensChecklistDoMarco(marco);
  if (itens.length === 0) {
    const vazio = document.createElement("p");
    vazio.className = "placeholder";
    vazio.textContent = "Nenhum item neste marco.";
    implantacaoMarcoItens.appendChild(vazio);
  }
  itens.forEach((item) => {
    const linha = criarLinhaItemMarco(item, item.extra ? () => {
      marcosRascunho.extras[marco] = marcosRascunho.extras[marco].filter((i) => i.id !== item.id);
    } : null);
    if (item.extra) {
      const tag = document.createElement("span");
      tag.className = "tag-resumo tag-persona";
      tag.textContent = "Só deste cliente";
      linha.insertBefore(tag, linha.querySelector(".btn-remover-item-marco"));
    }
    implantacaoMarcoItens.appendChild(linha);
  });
  implantacaoMarcoItens.appendChild(criarAdicionarInline("extra", "Adicionar item só para este cliente",
    "Descreva o item...", 200, (texto) => {
      marcosRascunho.extras[marco].push({ id: novoIdItemMarco(), texto });
    }));

  inputImplantacaoMarcoManual.checked = marcosRascunho.manual.has(marco);
  renderizarSubmenuMarcos();
}

inputImplantacaoMarcoManual.addEventListener("change", () => {
  if (!marcoAberto) return;
  if (inputImplantacaoMarcoManual.checked) marcosRascunho.manual.add(marcoAberto);
  else marcosRascunho.manual.delete(marcoAberto);
  marcosRascunhoAlterado = true;
  renderizarPainelMarco();
});


btnSalvarImplantacaoMarcos.addEventListener("click", async () => {
  const cliente = marcosCliente;
  if (!cliente || !marcosRascunho) return;
  btnSalvarImplantacaoMarcos.disabled = true;
  try {
    const r = await fetch(`/api/clientes/${cliente.id}/marcos`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        itens_feitos: Array.from(marcosRascunho.feitos),
        itens_extras: marcosRascunho.extras,
        prioridades: marcosRascunho.prioridades,
        concluidos_manual: Array.from(marcosRascunho.manual),
      }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao salvar: ${data.error || "falha desconhecida"}`);

    // Rascunho salvo — sem isso o recarregar da Ficha abaixo pediria pra
    // "descartar alterações".
    marcosRascunhoAlterado = false;
    const passagemAntes = (cliente.marcos_concluidos || []).includes("marco-3");

    // Marco 3 (passagem pro Onboarding) acabou de concluir: só SUGERE ligar
    // o "Implantado" — a decisão continua sendo da equipe.
    if (!passagemAntes && data.marcos_concluidos.includes("marco-3") && !cliente.implantado
        && confirm("Marco 3 concluído. Marcar o cliente como implantado?")) {
      await salvarImplantadoCliente(cliente, true, false);
    }

    // Recarrega a Ficha (cabeçalho, alertas, etapa) e volta pra aba Marcos,
    // no mesmo marco que estava aberto (construirFichaMarcos mantém).
    await carregarFichaCliente(cliente.idcentral, "marcos");
  } catch (err) {
    alert(`Erro ao salvar: ${String(err)}`);
  } finally {
    btnSalvarImplantacaoMarcos.disabled = false;
  }
});

// --- IMPORTAÇÃO DE CLIENTES POR PLANILHA (Implantação) ---
// Fluxo em 2 passos: sobe o arquivo -> prévia linha a linha (com erro
// destacado, sem gravar nada ainda) -> confirmar grava no Firestore.
const overlayImportarClientes = el("overlay-importar-clientes");
const inputImportarClientesArquivo = el("importar-clientes-arquivo");
const importarClientesPrevia = el("importar-clientes-prevista");
const btnImportarClientesConfirmar = el("btn-importar-clientes-confirmar");
let importarClientesFileId = null;

function abrirModalImportarClientes() {
  inputImportarClientesArquivo.value = "";
  importarClientesPrevia.innerHTML = "";
  importarClientesFileId = null;
  btnImportarClientesConfirmar.classList.add("hidden");
  btnImportarClientesConfirmar.disabled = false;
  overlayImportarClientes.classList.remove("hidden");
}

el("importar-clientes-modal-fechar").addEventListener("click", () => {
  overlayImportarClientes.classList.add("hidden");
});

function renderPreviaImportarClientes(data) {
  importarClientesPrevia.innerHTML = "";

  const resumo = document.createElement("p");
  resumo.className = "placeholder";
  resumo.textContent = `${data.prontos} de ${data.total} linha(s) prontas para importar.`;
  importarClientesPrevia.appendChild(resumo);

  const table = document.createElement("table");
  table.className = "tabela-saida";
  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  ["Linha", "IdCentral", "Cliente", "Etapa", "Status"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  data.linhas.forEach((l) => {
    const dados = l.dados || {};
    const etapaLabel = dados.etapa ? (IMPLANTACAO_ETAPA_LABELS[dados.etapa] || dados.etapa) : "-";
    const tr = document.createElement("tr");
    [l.linha, dados.idcentral || "-", dados.cliente || "-", etapaLabel].forEach((v) => {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    });
    const tdStatus = document.createElement("td");
    tdStatus.textContent = l.erro ? `Erro: ${l.erro}` : "Pronto";
    if (l.erro) tdStatus.style.color = "#b91c1c";
    tr.appendChild(tdStatus);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  importarClientesPrevia.appendChild(table);

  btnImportarClientesConfirmar.textContent = `Importar ${data.prontos} cliente(s)`;
  btnImportarClientesConfirmar.classList.toggle("hidden", data.prontos === 0);
}

inputImportarClientesArquivo.addEventListener("change", async () => {
  const file = inputImportarClientesArquivo.files[0];
  if (!file) return;
  importarClientesPrevia.innerHTML = '<p class="placeholder">Lendo planilha...</p>';
  btnImportarClientesConfirmar.classList.add("hidden");
  importarClientesFileId = null;

  const formData = new FormData();
  formData.append("arquivo", file);
  try {
    const r = await fetch("/api/clientes/importar/preview", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      importarClientesPrevia.innerHTML = "";
      return alert(data.error || "Falha ao ler planilha.");
    }
    importarClientesFileId = data.file_id;
    renderPreviaImportarClientes(data);
  } catch (err) {
    importarClientesPrevia.innerHTML = "";
    alert(String(err));
  }
});

btnImportarClientesConfirmar.addEventListener("click", async () => {
  if (!importarClientesFileId) return;
  btnImportarClientesConfirmar.disabled = true;
  btnImportarClientesConfirmar.textContent = "Importando...";
  try {
    const r = await fetch("/api/clientes/importar/confirmar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: importarClientesFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) throw new Error(data.error || "Falha ao importar.");

    const resumoFinal = document.createElement("div");
    resumoFinal.className = "resumo-final";
    resumoFinal.textContent = `Concluído! ${data.sucessos} cliente(s) importado(s)`
      + (data.erros.length ? `, ${data.erros.length} com erro.` : ".");
    importarClientesPrevia.appendChild(resumoFinal);
    btnImportarClientesConfirmar.classList.add("hidden");
    importarClientesFileId = null;

    await carregarImplantacaoClientes();
  } catch (err) {
    alert(String(err));
    btnImportarClientesConfirmar.disabled = false;
    btnImportarClientesConfirmar.textContent = "Importar";
  }
});

// --- LINHA DO TEMPO DO CLIENTE EM IMPLANTAÇÃO ---
// 4 setores fixos, cada um com cards de acontecimento (título/descrição/data/responsável)
// ordenados cronologicamente. A ordem aqui precisa bater com IMPLANTACAO_SETORES no app.py.
const IMPLANTACAO_SETORES = ["Implantação", "Migração", "Suporte", "Comercial"];

// Tag opcional do acontecimento (mesmas 6 + cores do "Acompanhamento de
// cliente" do kanban_dashboard_dev — replicado aqui pra manter o mesmo
// formato visual na Timeline da Ficha). A ordem aqui precisa bater com
// EVENTO_TAGS no app.py.
const EVENTO_TAGS = [
  ["Operação", "#2563EB"],
  ["Migração", "#16A34A"],
  ["Fricção", "#EAB308"],
  ["Sugestão de desenvolvimento", "#D1D5DB"],
  ["Travamento", "#FCA5A5"],
  ["Problema", "#991B1B"],
];
const EVENTO_TAG_COR = Object.fromEntries(EVENTO_TAGS);
const EVENTO_TAG_COR_PADRAO = "#94A3B8"; // acontecimento sem tag

// Cor de apoio pro acontecimento sem Tag (chat da aba Detalhado) — mesma
// paleta por setor já usada em .timeline-setor[data-setor=...], só que como
// valor de JS pra virar border-left da mensagem.
const IMPLANTACAO_SETOR_COR = {
  "Implantação": "var(--amarelo-escuro)",
  "Migração": "var(--violeta)",
  "Suporte": "var(--turquesa)",
  "Comercial": "var(--azul)",
};

// Versão "pastel" das Tags (fundo claro + texto na própria cor) só pro chip
// dentro da mensagem do chat — a cor sólida das Tags (EVENTO_TAG_COR) continua
// cheia na Timeline (bolinhas/legenda), mas ali vira peso demais lado a lado
// com o texto da mensagem.
const EVENTO_TAG_CHIP = {
  "Operação": { bg: "#DBEAFE", fg: "#1D4ED8" },
  "Migração": { bg: "#DCFCE7", fg: "#15803D" },
  "Fricção": { bg: "#FEF9C3", fg: "#A16207" },
  "Sugestão de desenvolvimento": { bg: "#F3F4F6", fg: "#4B5563" },
  "Travamento": { bg: "#FEE2E2", fg: "#B91C1C" },
  "Problema": { bg: "#FEE2E2", fg: "#7F1D1D" },
};

const overlayImplantacaoTimeline = el("overlay-implantacao-timeline");
const implantacaoTimelineTitulo = el("implantacao-timeline-titulo");
const implantacaoTimelineSetores = el("implantacao-timeline-setores");

const overlayImplantacaoEvento = el("overlay-implantacao-evento");
const formImplantacaoEvento = el("form-implantacao-evento");
const implantacaoEventoModalTitulo = el("implantacao-evento-modal-titulo");
const inputImplantacaoEventoTitulo = el("implantacao-evento-titulo");
const inputImplantacaoEventoTag = el("implantacao-evento-tag");
const inputImplantacaoEventoDescricao = el("implantacao-evento-descricao");
const inputImplantacaoEventoData = el("implantacao-evento-data");
const inputImplantacaoEventoResponsavel = el("implantacao-evento-responsavel");
const btnSalvarImplantacaoEvento = el("btn-salvar-implantacao-evento");

let implantacaoTimelineClienteAtual = null;
let implantacaoTimelineEventosCache = [];
let implantacaoEventoEditandoId = null;
let implantacaoEventoSetorAtual = null;

async function abrirTimelineImplantacao(cliente) {
  implantacaoTimelineClienteAtual = cliente;
  implantacaoTimelineTitulo.textContent = `Linha do tempo — ${cliente.cliente}`;
  implantacaoTimelineSetores.innerHTML = '<p class="placeholder">Carregando...</p>';
  overlayImplantacaoTimeline.classList.remove("hidden");
  await carregarImplantacaoEventos();
}

function mostrarErroEmNode(node, msg) {
  node.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  node.appendChild(p);
}

async function carregarImplantacaoEventos() {
  if (!implantacaoTimelineClienteAtual) return;
  try {
    const r = await fetch(`/api/clientes/${implantacaoTimelineClienteAtual.id}/eventos`);
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroEmNode(implantacaoTimelineSetores, data.error || "Falha ao carregar.");
    implantacaoTimelineEventosCache = data.eventos || [];
    renderTimelineSetores();
  } catch (err) {
    mostrarErroEmNode(implantacaoTimelineSetores, String(err));
  }
}

function construirCardEvento(ev) {
  const card = document.createElement("div");
  card.className = "timeline-card";

  const acoes = document.createElement("div");
  acoes.className = "timeline-card-acoes";
  const btnEditar = document.createElement("button");
  btnEditar.className = "btn-engrenagem";
  btnEditar.classList.add("btn-engrenagem-icone");
  btnEditar.title = "Editar";
  aplicarIconeEngrenagem(btnEditar);
  btnEditar.addEventListener("click", () => abrirModalImplantacaoEvento(ev.setor, ev));
  const btnExcluir = document.createElement("button");
  btnExcluir.className = "btn-engrenagem btn-excluir";
  btnExcluir.textContent = "🗑";
  btnExcluir.title = "Excluir";
  btnExcluir.addEventListener("click", async () => {
    if (!confirm(`Excluir "${ev.titulo}"?`)) return;
    try {
      const r = await fetch(`/api/clientes/${implantacaoTimelineClienteAtual.id}/eventos/${ev.id}`, { method: "DELETE" });
      const data = await parseJsonResponse(r);
      if (!data.ok) return alert(data.error || "Falha ao excluir.");
      await carregarImplantacaoEventos();
      await carregarImplantacaoClientes();
    } catch (err) {
      alert(String(err));
    }
  });
  acoes.appendChild(btnEditar);
  acoes.appendChild(btnExcluir);
  card.appendChild(acoes);

  const titulo = document.createElement("div");
  titulo.className = "timeline-card-titulo";
  titulo.textContent = ev.titulo;
  card.appendChild(titulo);

  const data = document.createElement("div");
  data.className = "timeline-card-data";
  data.textContent = formatarDataBRSimples(ev.data) || "Sem data";
  card.appendChild(data);

  if (ev.tag) {
    const tag = document.createElement("span");
    tag.className = "timeline-card-tag";
    tag.style.backgroundColor = EVENTO_TAG_COR[ev.tag] || EVENTO_TAG_COR_PADRAO;
    tag.textContent = ev.tag;
    card.appendChild(tag);
  }

  if (ev.descricao) {
    const desc = document.createElement("div");
    desc.className = "timeline-card-descricao";
    desc.textContent = ev.descricao;
    card.appendChild(desc);
  }

  if (ev.responsavel) {
    const resp = document.createElement("div");
    resp.className = "timeline-card-responsavel";
    resp.textContent = `Responsável: ${ev.responsavel}`;
    card.appendChild(resp);
  }

  return card;
}

function renderTimelineSetores() {
  implantacaoTimelineSetores.innerHTML = "";
  IMPLANTACAO_SETORES.forEach((setor) => {
    const linha = document.createElement("div");
    linha.className = "timeline-setor";
    linha.dataset.setor = setor;

    const cabecalho = document.createElement("div");
    cabecalho.className = "timeline-setor-cabecalho";
    const nome = document.createElement("span");
    nome.className = "timeline-setor-nome";
    nome.textContent = setor;
    const btnAdd = document.createElement("button");
    btnAdd.className = "btn-secondary";
    btnAdd.textContent = "+";
    btnAdd.title = `Adicionar acontecimento em ${setor}`;
    btnAdd.addEventListener("click", () => abrirModalImplantacaoEvento(setor, null));
    cabecalho.appendChild(nome);
    cabecalho.appendChild(btnAdd);
    linha.appendChild(cabecalho);

    const cardsDoSetor = implantacaoTimelineEventosCache
      .filter((ev) => ev.setor === setor)
      .slice()
      .sort((a, b) => String(a.data || "").localeCompare(String(b.data || "")));

    if (cardsDoSetor.length === 0) {
      const vazio = document.createElement("p");
      vazio.className = "timeline-setor-vazio";
      vazio.textContent = "Nenhum acontecimento registrado.";
      linha.appendChild(vazio);
    } else {
      const cardsWrap = document.createElement("div");
      cardsWrap.className = "timeline-setor-cards";
      cardsDoSetor.forEach((ev) => cardsWrap.appendChild(construirCardEvento(ev)));
      linha.appendChild(cardsWrap);
    }

    implantacaoTimelineSetores.appendChild(linha);
  });
}

function abrirModalImplantacaoEvento(setor, evento) {
  implantacaoEventoEditandoId = evento ? evento.id : null;
  implantacaoEventoSetorAtual = setor;
  implantacaoEventoModalTitulo.textContent = evento ? `Editar acontecimento — ${setor}` : `Adicionar acontecimento — ${setor}`;
  inputImplantacaoEventoTitulo.value = evento ? evento.titulo : "";
  inputImplantacaoEventoTag.value = evento ? evento.tag || "" : "";
  inputImplantacaoEventoDescricao.value = evento ? evento.descricao || "" : "";
  inputImplantacaoEventoData.value = evento ? evento.data || "" : "";
  inputImplantacaoEventoResponsavel.value = evento ? evento.responsavel || "" : "";
  btnSalvarImplantacaoEvento.textContent = evento ? "Salvar edição" : "Adicionar";
  overlayImplantacaoEvento.classList.remove("hidden");
  inputImplantacaoEventoTitulo.focus();
}

el("implantacao-evento-modal-fechar").addEventListener("click", () => overlayImplantacaoEvento.classList.add("hidden"));

formImplantacaoEvento.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!implantacaoTimelineClienteAtual || !implantacaoEventoSetorAtual) return;
  const payload = {
    setor: implantacaoEventoSetorAtual,
    titulo: inputImplantacaoEventoTitulo.value.trim(),
    tag: inputImplantacaoEventoTag.value,
    descricao: inputImplantacaoEventoDescricao.value.trim(),
    data: inputImplantacaoEventoData.value,
    responsavel: inputImplantacaoEventoResponsavel.value.trim(),
  };
  if (!payload.titulo) return;
  try {
    const clienteId = implantacaoTimelineClienteAtual.id;
    const url = implantacaoEventoEditandoId
      ? `/api/clientes/${clienteId}/eventos/${implantacaoEventoEditandoId}`
      : `/api/clientes/${clienteId}/eventos`;
    const method = implantacaoEventoEditandoId ? "PUT" : "POST";
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao salvar: ${data.error || "falha desconhecida"}`);
    overlayImplantacaoEvento.classList.add("hidden");
    await carregarImplantacaoEventos();
    await carregarImplantacaoClientes();
  } catch (err) {
    alert(`Erro ao salvar: ${String(err)}`);
  }
});

el("implantacao-timeline-fechar").addEventListener("click", () => overlayImplantacaoTimeline.classList.add("hidden"));

// --- CLIENTES EM MIGRAÇÃO ---
const overlayMigracao = el("overlay-migracao");
const modalMigracaoEl = el("modal-migracao");
const migracaoSidebarConfig = el("migracao-sidebar-config");
const formMigracao = el("form-migracao");
const migracaoModalTitulo = el("migracao-modal-titulo");
const wrapMigracaoNome = el("migracao-nome-wrap");
const inputMigracaoNome = el("migracao-nome");
const inputMigracaoIdcentral = el("migracao-idcentral");
const inputMigracaoCs = el("migracao-cs");
const inputMigracaoEtapa = el("migracao-etapa");
const inputMigracaoPlataforma = el("migracao-plataforma");
const inputMigracaoLinkAcessoOrigem = el("migracao-link-acesso-origem");
const inputMigracaoLoginAcessoOrigem = el("migracao-login-acesso-origem");
const inputMigracaoSenhaAcessoOrigem = el("migracao-senha-acesso-origem");
const inputMigracaoLinkPlanilha = el("migracao-link-planilha");
const btnCriarPlanilhaMigracao = el("btn-criar-planilha-migracao");
const btnLiberarLinkPlanilha = el("btn-liberar-link-planilha");
const inputMigracaoQtdClientes = el("migracao-qtd-clientes");
const inputMigracaoQtdPlacas = el("migracao-qtd-placas");
const inputMigracaoPercentual = el("migracao-percentual");
// Precisa bater com as opções do <select id="migracao-etapa"> e com MIGRACAO_ETAPAS no
// app.py — são as colunas oficiais do Kanban de Migração.
const MIGRACAO_ETAPA_LABELS = {
  analise: "Análise / Coleta de Dados",
  importacao: "Importação",
  comandos: "Envio de Comandos",
  concluido: "Validação / Concluído",
};
const MIGRACAO_ETAPAS_ORDEM = ["analise", "importacao", "comandos", "concluido"];
// Status de uma tentativa de migração (clientes/<id>/migracoes/<id>) — precisa
// bater com STATUS_MIGRACAO_VALIDOS no app.py.
const MIGRACAO_STATUS_LABELS = {
  em_andamento: "Em andamento",
  concluida: "Concluída",
  cancelada: "Cancelada",
  incompleta: "Incompleta",
};

let clienteMigracaoAtualId = null;
let veiculosMigracaoModelosCache = []; // {modelo, porta, comando_template}[] do cliente atual
let migracaoClientesCache = [];
let migracaoView = "kanban"; // "kanban" | "lista"
let migracaoFiltroTexto = "";
let migracaoFiltroCs = "";

async function carregarClientesMigracao() {
  mostrarPlaceholder("Carregando clientes em migração...");
  try {
    const r = await fetch("/api/migracao/clientes");
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErro(data.error || "Falha ao carregar.");
    migracaoClientesCache = data.clientes || [];
    await mostrarTabelaMigracao();
  } catch (err) {
    mostrarErro(String(err));
  }
}

// Monta só o <table> — mesmo padrão de construirTabelaImplantacao.
// "Excluir" na tela de Migração tem 3 casos, conforme a origem do item (ver
// GET /api/migracao/clientes):
// - legado: apaga o doc da coleção solta antiga, igual sempre foi.
// - unificado + tem_implantacao=false: cliente só existe por causa dessa
//   migração (criado pelo "+ Adicionar Cliente" sem IdCentral já existente)
//   — exclui o cliente inteiro.
// - unificado + tem_implantacao=true: cliente "de verdade" da Implantação
//   que também tem migração — não dá pra apagar o cliente por aqui, só
//   cancela a tentativa (mesma ação que a Ficha usa).
async function excluirClienteMigracao(c) {
  const unificado = c.origem === "unificado";
  const apagaClienteTodo = !unificado || c.tem_implantacao === false;
  const aviso = apagaClienteTodo
    ? `Excluir o cliente "${c.nome}" e todos os veículos dele? Essa ação não pode ser desfeita.`
    : `Remover a migração de "${c.nome}"? O cadastro dele na Implantação continua existindo — só a migração é cancelada.`;
  if (!confirm(aviso)) return;
  try {
    const url = !unificado
      ? `/api/migracao/clientes/${c.id}`
      : apagaClienteTodo
        ? `/api/clientes/${c.cliente_id}`
        : `/api/clientes/${c.cliente_id}/migracoes/${c.migracao_id}/cancelar`;
    const r = await fetch(url, { method: !unificado || apagaClienteTodo ? "DELETE" : "POST" });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErro(data.error || "Falha ao excluir.");
    await carregarClientesMigracao();
  } catch (err) {
    mostrarErro(String(err));
  }
}

function construirTabelaMigracao(clientes) {
  const headers = ["Nome", "Responsável", "Etapa", "Plataforma de origem", "Quantidade de Clientes", "Quantidade de Placas", "Porcentagem da migração", ""];
  const table = document.createElement("table");
  table.className = "tabela-saida";

  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  if (clientes.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = headers.length;
    td.textContent = "Nenhum cliente ainda. Clique em \"+ Adicionar Cliente\" pra começar.";
    td.style.color = "#6b7280";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  clientes.forEach((c) => {
    const tr = document.createElement("tr");
    tr.className = "linha-clicavel";
    tr.title = "Clique para ver os veículos importados";
    tr.addEventListener("click", () => abrirClienteOuFicha(c, abrirVeiculosMigracao));
    const etapaLabelMig = MIGRACAO_ETAPA_LABELS[c.etapa] || MIGRACAO_ETAPA_LABELS.analise;
    [c.nome, c.cs, etapaLabelMig, c.plataforma_origem, c.qtd_clientes, c.qtd_placas, `${c.percentual_migracao}%`].forEach((v) => {
      const td = document.createElement("td");
      td.textContent = v === null || v === undefined || v === "" ? "-" : String(v);
      tr.appendChild(td);
    });

    const tdAcoes = document.createElement("td");
    tdAcoes.className = "acoes-credencial";

    const btnConfig = document.createElement("button");
    btnConfig.className = "btn-engrenagem";
    btnConfig.classList.add("btn-engrenagem-icone");
    btnConfig.title = "Configurar CS, plataforma, percentual...";
    aplicarIconeEngrenagem(btnConfig);
    btnConfig.addEventListener("click", (e) => {
      e.stopPropagation();
      abrirModalMigracao(c);
    });
    tdAcoes.appendChild(btnConfig);

    const btnExcluirCliente = document.createElement("button");
    btnExcluirCliente.className = "btn-engrenagem btn-excluir";
    btnExcluirCliente.textContent = "🗑";
    btnExcluirCliente.title = "Excluir cliente";
    btnExcluirCliente.addEventListener("click", (e) => {
      e.stopPropagation();
      excluirClienteMigracao(c);
    });
    tdAcoes.appendChild(btnExcluirCliente);

    tr.appendChild(tdAcoes);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

// Card genérico de Kanban: monta a coluna por etapa e delega o conteúdo de cada
// card pra quem chama (hoje só a Migração usa — o Kanban de Implantação, com
// seus 5 marcos fixos, tem sua própria versão em construirKanbanMarcos).
// Colunas em número fixo (uma por etapa, não rolagem infinita de cards), então
// usa grid-template-columns com a MESMA contagem de colunas — igual ao
// .kmarcos-board da Implantação — pra encolher direitinho em telas menores
// (ex.: sidebar aberta) em vez de manter uma largura mínima grande e forçar
// scroll horizontal à toa.
function construirKanban(clientes, etapasOrdem, etapaLabels, campoEtapa, montarConteudoCard, aoClicarCard) {
  const board = document.createElement("div");
  board.className = "kanban-board";
  board.style.gridTemplateColumns = `repeat(${etapasOrdem.length}, minmax(200px, 1fr))`;
  etapasOrdem.forEach((etapaId) => {
    const doColuna = clientes.filter((c) => (c[campoEtapa] || etapasOrdem[0]) === etapaId);

    const coluna = document.createElement("div");
    coluna.className = "kanban-coluna";

    const cabecalho = document.createElement("div");
    cabecalho.className = "kanban-coluna-cabecalho";
    const nomeEtapa = document.createElement("span");
    nomeEtapa.className = "kanban-coluna-nome";
    nomeEtapa.textContent = etapaLabels[etapaId] || etapaId;
    const contagem = document.createElement("span");
    contagem.className = "kanban-coluna-contagem";
    contagem.textContent = String(doColuna.length);
    cabecalho.appendChild(nomeEtapa);
    cabecalho.appendChild(contagem);
    coluna.appendChild(cabecalho);

    if (doColuna.length === 0) {
      const vazio = document.createElement("div");
      vazio.className = "kanban-vazio";
      vazio.textContent = "Nenhum cliente nesta etapa";
      coluna.appendChild(vazio);
    }

    doColuna.forEach((c) => {
      // Div, não button: o conteúdo do card (montarConteudoCard) inclui o botão
      // "Ficha", e button dentro de button é HTML inválido.
      const card = document.createElement("div");
      card.className = "kanban-card";
      card.addEventListener("click", () => aoClicarCard(c));
      const conteudo = montarConteudoCard(c);
      // .risco-borda é marcado no conteúdo (só quem conhece as regras de
      // negócio de cada tipo de card sabe se aplica) mas a borda em si
      // precisa ir no .kanban-card de fora — é ele que tem a borda visível.
      if (conteudo.classList.contains("risco-borda")) card.classList.add("kanban-card-risco");
      card.appendChild(conteudo);
      coluna.appendChild(card);
    });

    board.appendChild(coluna);
  });
  return board;
}

// Linha "rótulo: valor" com o mesmo padrão de hierarquia do card de
// Implantação (.kmarcos-card-linha strong) — rótulo cinza, valor em negrito
// escuro — em vez de tudo no mesmo cinza sem destaque.
function criarMetaKanbanMigracao(prefixo, valorForte, sufixo) {
  const linha = document.createElement("div");
  linha.className = "kanban-card-meta";
  if (prefixo) linha.appendChild(document.createTextNode(prefixo));
  const forte = document.createElement("strong");
  forte.textContent = valorForte;
  linha.appendChild(forte);
  if (sufixo) linha.appendChild(document.createTextNode(sufixo));
  return linha;
}

function montarConteudoCardMigracao(c) {
  const wrap = document.createElement("div");
  wrap.className = "kanban-card-conteudo";

  const nome = document.createElement("div");
  nome.className = "kanban-card-nome";
  nome.textContent = c.nome;
  wrap.appendChild(nome);

  // Mesmo ícone/linha do card de Implantação (linhaCardMarcos, já definida
  // mais acima) — ícone de pessoa pro responsável.
  wrap.appendChild(linhaCardMarcos("pessoa", c.cs || "Sem responsável"));

  if (c.plataforma_origem) {
    wrap.appendChild(criarMetaKanbanMigracao("Origem: ", c.plataforma_origem));
  }

  // Data + "(Xd)" no mesmo formato da data de entrada do card de Implantação
  // (ícone de calendário, data em negrito, dias apagado entre parênteses).
  // Coleção legada (ver GET /api/migracao/clientes) não tem data_inicio —
  // sem ela não dá pra montar essa linha.
  const dataInicioBR = formatarDataBRSimples(c.data_inicio);
  if (dataInicioBR) {
    const frag = document.createElement("span");
    const forte = document.createElement("strong");
    forte.textContent = dataInicioBR;
    frag.appendChild(forte);
    const dias = c.data_fim ? diasEntre(c.data_inicio, c.data_fim) : diasDesdeEntrada(c.data_inicio);
    if (dias !== null) {
      const d = document.createElement("span");
      d.className = "kmarcos-card-apagado";
      d.textContent = ` (${dias}d)`;
      frag.appendChild(d);
    }
    wrap.appendChild(linhaCardMarcos("calendario", frag));
  }

  const barraBg = document.createElement("div");
  barraBg.className = "progresso-bar-bg";
  const barra = document.createElement("div");
  barra.className = "progresso-bar";
  const pct = Math.max(0, Math.min(100, Math.round(Number(c.percentual_migracao) || 0)));
  barra.style.width = `${pct}%`;
  barraBg.appendChild(barra);
  wrap.appendChild(barraBg);

  return wrap;
}

// Barra de estatísticas acima do Kanban — mesmo padrão visual da barra de
// Implantação (construirBarraStatsMarcos), só que com métricas que existem
// de fato pros clientes em migração.
function construirBarraStatsMigracao(clientes) {
  const barra = document.createElement("div");
  barra.className = "kmarcos-stats";

  function bloco(rotulo, valor, classe) {
    const b = document.createElement("div");
    b.className = `kmarcos-stat${classe ? ` ${classe}` : ""}`;
    const r = document.createElement("span");
    r.className = "kmarcos-stat-rotulo";
    r.textContent = rotulo;
    const v = document.createElement("span");
    v.className = "kmarcos-stat-valor";
    v.textContent = String(valor);
    b.appendChild(r);
    b.appendChild(v);
    barra.appendChild(b);
  }

  const concluidos = clientes.filter((c) => c.etapa === "concluido").length;
  bloco("Total", clientes.length, "kmarcos-stat-total");
  bloco("Concluídos", concluidos, "kmarcos-stat-ok");
  bloco("Em andamento", clientes.length - concluidos, "kmarcos-stat-total");
  bloco("Sem responsável", clientes.filter((c) => !c.cs).length, "kmarcos-stat-parado");
  return barra;
}

async function mostrarTabelaMigracao() {
  const wrapper = document.createElement("div");
  wrapper.className = "saida-view";

  const toolbar = document.createElement("div");
  toolbar.className = "migracao-toolbar saida-view-toolbar";
  const btnAdicionarCliente = document.createElement("button");
  btnAdicionarCliente.className = "btn-primary";
  btnAdicionarCliente.textContent = "+ Adicionar Cliente";
  btnAdicionarCliente.addEventListener("click", abrirModalMigracaoNovo);
  toolbar.appendChild(btnAdicionarCliente);

  toolbar.appendChild(criarCampoFiltroLista(migracaoFiltroTexto, (valor) => {
    migracaoFiltroTexto = valor;
    atualizarConteudo();
  }));

  const selectFiltroCs = document.createElement("select");
  selectFiltroCs.className = "toolbar-filtro-responsavel";
  const optTodosCs = document.createElement("option");
  optTodosCs.value = "";
  optTodosCs.textContent = "Todos os responsáveis";
  selectFiltroCs.appendChild(optTodosCs);
  (await buscarUsuariosOpcoes("area_prefix=CS")).forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.nome;
    opt.textContent = u.nome;
    selectFiltroCs.appendChild(opt);
  });
  selectFiltroCs.value = migracaoFiltroCs;
  toolbar.appendChild(selectFiltroCs);

  const segView = document.createElement("div");
  segView.className = "segmentado";
  const btnViewKanban = document.createElement("button");
  btnViewKanban.type = "button";
  btnViewKanban.textContent = "Kanban";
  const btnViewLista = document.createElement("button");
  btnViewLista.type = "button";
  btnViewLista.textContent = "Lista";
  segView.appendChild(btnViewKanban);
  segView.appendChild(btnViewLista);
  toolbar.appendChild(segView);

  wrapper.appendChild(toolbar);

  const conteudoContainer = document.createElement("div");
  conteudoContainer.className = "saida-view-corpo";
  wrapper.appendChild(conteudoContainer);

  function clientesFiltrados() {
    const filtro = normalizarBusca(migracaoFiltroTexto);
    let filtrados = filtro
      ? migracaoClientesCache.filter((c) => normalizarBusca(`${c.nome || ""} ${c.idcentral || ""}`).includes(filtro))
      : migracaoClientesCache.slice();
    if (migracaoFiltroCs) {
      filtrados = filtrados.filter((c) => c.cs === migracaoFiltroCs);
    }
    return filtrados;
  }

  function atualizarConteudo() {
    const filtrados = clientesFiltrados();
    conteudoContainer.innerHTML = "";
    if (migracaoView === "kanban") {
      const wrapKanban = document.createElement("div");
      wrapKanban.className = "kmarcos-wrap";
      wrapKanban.appendChild(construirBarraStatsMigracao(filtrados));
      wrapKanban.appendChild(
        construirKanban(filtrados, MIGRACAO_ETAPAS_ORDEM, MIGRACAO_ETAPA_LABELS, "etapa", montarConteudoCardMigracao, (c) => abrirClienteOuFicha(c, abrirVeiculosMigracao))
      );
      conteudoContainer.appendChild(wrapKanban);
    } else {
      conteudoContainer.appendChild(construirTabelaMigracao(filtrados));
    }
    btnViewKanban.classList.toggle("ativo", migracaoView === "kanban");
    btnViewLista.classList.toggle("ativo", migracaoView === "lista");
  }

  selectFiltroCs.addEventListener("change", () => {
    migracaoFiltroCs = selectFiltroCs.value;
    atualizarConteudo();
  });

  btnViewKanban.addEventListener("click", () => { migracaoView = "kanban"; atualizarConteudo(); });
  btnViewLista.addEventListener("click", () => { migracaoView = "lista"; atualizarConteudo(); });

  atualizarConteudo();
  setSaida(wrapper);
}

// Caminho base da API dessa janela de configuração — muda conforme a origem:
// tela antiga solta de Migração (/api/migracao/clientes/<id>) ou uma tentativa
// nova pendurada num cliente (/api/clientes/<id>/migracoes/<id>). Mesmo padrão
// usado no módulo de Veículos (veiculosMigracaoBaseUrl) — um módulo só, sem
// duplicar lógica pras duas origens.
let migracaoConfigBaseUrl = null;
// true quando aberta via cliente da lista única (esconde IdCentral/Responsável,
// que agora vivem no cadastro do cliente, não na tentativa de migração).
let migracaoConfigModoNovo = false;
// true só enquanto cria um cliente do zero (botão "+ Adicionar Cliente") —
// mostra o campo Nome e esconde Modelos de rastreador (só existe depois que o
// cliente é criado). Ver formMigracao.addEventListener("submit").
let migracaoConfigModoCriar = false;
const wrapMigracaoModelos = el("migracao-modelos-bloco");

// Depois que o link da planilha é salvo uma vez, trava o campo (evita trocar
// ou recriar a planilha sem querer) — só admin vê o botão "Liberar edição",
// que pede confirmação (overlay-liberar-planilha) antes de destravar.
// true só entre confirmar "Liberar edição" e a próxima criação/fechamento —
// é o que diferencia, pro backend, "nunca teve planilha" de "tinha e um admin
// decidiu substituir de propósito" (ver POST .../criar-planilha, campo
// "substituir"). Reseta sempre que o estado do campo é recalculado (abrir
// modal, ou depois de criar uma planilha nova).
let migracaoPlanilhaSubstituir = false;

function aplicarEstadoLinkPlanilha(linkAtual) {
  const travado = Boolean(linkAtual);
  inputMigracaoLinkPlanilha.readOnly = travado;
  inputMigracaoLinkPlanilha.classList.toggle("input-travado", travado);
  btnCriarPlanilhaMigracao.classList.toggle("hidden", travado);
  btnLiberarLinkPlanilha.classList.toggle("hidden", !travado || USUARIO_PERFIL_ATUAL !== "adm");
  migracaoPlanilhaSubstituir = false;
}

async function abrirModalMigracao(cliente) {
  // Sidebar de troca Implantação/Migração só aparece quando o modal é aberto
  // pela engrenagem da Ficha (abrirConfigFicha) — nos outros pontos de
  // entrada (lista de Migração, etc.) começa sempre escondida.
  migracaoSidebarConfig.classList.add("hidden");
  modalMigracaoEl.classList.remove("tem-sidebar-config");
  // "unificado" (ver GET /api/migracao/clientes): nome/idcentral/responsável
  // já são do cliente (clientes/<id>), não da tentativa — edita só pela
  // Ficha dele, mesmo tratamento que abrirConfigMigracaoCliente já dá.
  const unificado = cliente.origem === "unificado";
  migracaoConfigBaseUrl = unificado
    ? `/api/clientes/${cliente.cliente_id}/migracoes/${cliente.migracao_id}`
    : `/api/migracao/clientes/${cliente.id}`;
  migracaoConfigModoNovo = false;
  migracaoConfigModoCriar = false;
  clienteMigracaoAtualId = cliente.id;
  wrapMigracaoNome.classList.add("hidden");
  wrapMigracaoModelos.classList.remove("hidden");
  el("migracao-idcentral-wrap").classList.toggle("hidden", unificado);
  el("migracao-cs-wrap").classList.toggle("hidden", unificado);
  migracaoModalTitulo.textContent = cliente.nome;
  inputMigracaoIdcentral.value = cliente.idcentral || "";
  const idcentralTravadoMig = USUARIO_PERFIL_ATUAL !== "adm";
  inputMigracaoIdcentral.disabled = idcentralTravadoMig;
  inputMigracaoIdcentral.title = idcentralTravadoMig ? "Só administradores podem alterar o IdCentral." : "";
  await popularSelectUsuariosPorArea(inputMigracaoCs, cliente.cs || "", "area_prefix=CS");
  inputMigracaoEtapa.value = cliente.etapa || "analise";
  inputMigracaoPlataforma.value = cliente.plataforma_origem || "";
  inputMigracaoLinkAcessoOrigem.value = cliente.link_acesso_origem || "";
  inputMigracaoLoginAcessoOrigem.value = cliente.login_acesso_origem || "";
  inputMigracaoSenhaAcessoOrigem.value = cliente.senha_acesso_origem || "";
  inputMigracaoLinkPlanilha.value = cliente.link_planilha || "";
  inputMigracaoQtdClientes.value = cliente.qtd_clientes || 0;
  inputMigracaoQtdPlacas.value = cliente.qtd_placas || 0;
  inputMigracaoPercentual.value = cliente.percentual_migracao || 0;
  aplicarEstadoLinkPlanilha(cliente.link_planilha);
  overlayMigracao.classList.remove("hidden");
  resetFormMigracaoModelo();
  carregarMigracaoModelos();
}

// Abre o mesmo modal de configuração, mas vazio e em modo criação — troca o
// prompt() nativo que existia antes por um formulário de verdade, igual ao
// "+ Adicionar cliente" da Implantação. O cliente só é criado de fato (POST)
// no submit; até lá nada é gravado.
async function abrirModalMigracaoNovo() {
  migracaoSidebarConfig.classList.add("hidden");
  modalMigracaoEl.classList.remove("tem-sidebar-config");
  migracaoConfigBaseUrl = null;
  migracaoConfigModoNovo = false;
  migracaoConfigModoCriar = true;
  clienteMigracaoAtualId = null;
  wrapMigracaoNome.classList.remove("hidden");
  wrapMigracaoModelos.classList.add("hidden");
  inputMigracaoNome.value = "";
  el("migracao-idcentral-wrap").classList.remove("hidden");
  el("migracao-cs-wrap").classList.remove("hidden");
  migracaoModalTitulo.textContent = "Adicionar cliente";
  inputMigracaoIdcentral.value = "";
  inputMigracaoIdcentral.disabled = false;
  inputMigracaoIdcentral.title = "";
  await popularSelectUsuariosPorArea(inputMigracaoCs, "", "area_prefix=CS");
  inputMigracaoEtapa.value = "analise";
  inputMigracaoPlataforma.value = "";
  inputMigracaoLinkAcessoOrigem.value = "";
  inputMigracaoLoginAcessoOrigem.value = "";
  inputMigracaoSenhaAcessoOrigem.value = "";
  inputMigracaoLinkPlanilha.value = "";
  inputMigracaoQtdClientes.value = 0;
  inputMigracaoQtdPlacas.value = 0;
  inputMigracaoPercentual.value = 0;
  // Só dá pra copiar a planilha-modelo depois que a migração existir de fato
  // (o endpoint grava o link nela) — esconde até o cliente ser criado, e o
  // campo começa destravado (nada foi salvo ainda).
  aplicarEstadoLinkPlanilha("");
  btnCriarPlanilhaMigracao.classList.add("hidden");
  overlayMigracao.classList.remove("hidden");
  inputMigracaoNome.focus();
}

// Ponto de entrada novo: "Configurações de Migração" de uma tentativa pendurada
// num cliente da lista única — chamada pela Ficha (Migração > engrenagem) e
// pelo botão "Configurações de Migração" no cadastro quando já há uma ativa.
function abrirConfigMigracaoCliente(implantacao, migracao) {
  migracaoSidebarConfig.classList.add("hidden");
  modalMigracaoEl.classList.remove("tem-sidebar-config");
  migracaoConfigBaseUrl = `/api/clientes/${implantacao.id}/migracoes/${migracao.id}`;
  migracaoConfigModoNovo = true;
  migracaoConfigModoCriar = false;
  clienteMigracaoAtualId = implantacao.id;
  wrapMigracaoNome.classList.add("hidden");
  wrapMigracaoModelos.classList.remove("hidden");
  // IdCentral/Responsável agora são do cliente (cadastro em Implantação), não
  // da tentativa — escondidos aqui pra não parecer que dá pra editar por aqui.
  el("migracao-idcentral-wrap").classList.add("hidden");
  el("migracao-cs-wrap").classList.add("hidden");
  migracaoModalTitulo.textContent = `${implantacao.cliente} — Configurações de Migração`;
  inputMigracaoEtapa.value = migracao.etapa || "analise";
  inputMigracaoPlataforma.value = migracao.plataforma_origem || "";
  inputMigracaoLinkAcessoOrigem.value = migracao.link_acesso_origem || "";
  inputMigracaoLoginAcessoOrigem.value = migracao.login_acesso_origem || "";
  inputMigracaoSenhaAcessoOrigem.value = migracao.senha_acesso_origem || "";
  inputMigracaoLinkPlanilha.value = migracao.link_planilha || "";
  inputMigracaoQtdClientes.value = migracao.qtd_clientes || 0;
  inputMigracaoQtdPlacas.value = migracao.qtd_placas || 0;
  inputMigracaoPercentual.value = migracao.percentual_migracao || 0;
  aplicarEstadoLinkPlanilha(migracao.link_planilha);
  overlayMigracao.classList.remove("hidden");
  resetFormMigracaoModelo();
  carregarMigracaoModelos();
}

el("migracao-modal-fechar").addEventListener("click", () => {
  overlayMigracao.classList.add("hidden");
  fichaConfigContexto = null;
});
migracaoSidebarConfig.querySelectorAll(".modal-sidebar-config-item").forEach((btn) => {
  btn.addEventListener("click", () => mostrarConfigFichaAba(btn.dataset.aba));
});

// --- Confirmação "Vincular cliente" (checarVinculoMigracao) ---
// Ao criar um cliente de Migração, o IdCentral pode já pertencer a um cliente
// de Implantação — nesse caso perguntamos antes de criar qualquer coisa, pra
// não duplicar cliente (ver formMigracao submit, modo criar). Modal próprio
// em vez de confirm() nativo, pra não quebrar a identidade visual do app.
const overlayVincularMigracao = el("overlay-vincular-migracao");
const textoVincularMigracao = el("vincular-migracao-texto");
let resolverVinculoMigracao = null;
function fecharVincularMigracao(vincular) {
  overlayVincularMigracao.classList.add("hidden");
  const resolve = resolverVinculoMigracao;
  resolverVinculoMigracao = null;
  if (resolve) resolve(vincular);
}
function confirmarVincularMigracao(nomeCliente) {
  textoVincularMigracao.textContent = `Encontramos um cliente${nomeCliente ? ` (${nomeCliente})` : ""} com este IdCentral na Implantação. Deseja vincular esta migração a ele?`;
  overlayVincularMigracao.classList.remove("hidden");
  return new Promise((resolve) => { resolverVinculoMigracao = resolve; });
}
el("vincular-migracao-fechar").addEventListener("click", () => fecharVincularMigracao(false));
el("btn-vincular-migracao-sim").addEventListener("click", () => fecharVincularMigracao(true));
el("btn-vincular-migracao-nao").addEventListener("click", () => fecharVincularMigracao(false));

// Copia a planilha-modelo de cronograma de migração (Drive) e preenche o
// campo "Link da planilha" com a cópia nova — só disponível depois que a
// migração já existe (ver toggles de btnCriarPlanilhaMigracao acima).
btnCriarPlanilhaMigracao.addEventListener("click", async () => {
  if (!migracaoConfigBaseUrl) return;
  const textoOriginal = btnCriarPlanilhaMigracao.textContent;
  btnCriarPlanilhaMigracao.disabled = true;
  btnCriarPlanilhaMigracao.textContent = "Criando...";
  try {
    const r = await fetch(`${migracaoConfigBaseUrl}/criar-planilha`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ substituir: migracaoPlanilhaSubstituir }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      alert(`Erro ao criar planilha: ${data.error || "falha desconhecida"}`);
      return;
    }
    inputMigracaoLinkPlanilha.value = data.link;
    aplicarEstadoLinkPlanilha(data.link);
    // O back-end já salvou no Firestore (ver /criar-planilha), mas o cache
    // local (fichaClienteAtual / migracaoClientesCache) continua com a versão
    // antiga — sem isso, fechar o modal sem clicar "Salvar" e abrir de novo
    // mostrava o campo vazio (dado certo no banco, só a tela desatualizada).
    if (fichaConfigContexto && fichaConfigContexto.implantacao) {
      await carregarFichaCliente(fichaConfigContexto.implantacao.idcentral);
      if (fichaClienteAtual && fichaClienteAtual.migracao) {
        fichaConfigContexto.migracao = fichaClienteAtual.migracao;
      }
    } else {
      await carregarClientesMigracao();
    }
  } catch (err) {
    alert(`Erro ao criar planilha: ${String(err)}`);
  } finally {
    btnCriarPlanilhaMigracao.disabled = false;
    btnCriarPlanilhaMigracao.textContent = textoOriginal;
  }
});

// "Liberar edição" (só admin, ver aplicarEstadoLinkPlanilha) — confirma antes
// de destravar o campo/mostrar "Criar planilha" de novo, pra não substituir a
// planilha já salva sem querer.
const overlayLiberarPlanilha = el("overlay-liberar-planilha");
function fecharLiberarPlanilha() {
  overlayLiberarPlanilha.classList.add("hidden");
}
btnLiberarLinkPlanilha.addEventListener("click", () => overlayLiberarPlanilha.classList.remove("hidden"));
el("liberar-planilha-fechar").addEventListener("click", fecharLiberarPlanilha);
el("btn-liberar-planilha-nao").addEventListener("click", fecharLiberarPlanilha);
el("btn-liberar-planilha-sim").addEventListener("click", () => {
  fecharLiberarPlanilha();
  inputMigracaoLinkPlanilha.readOnly = false;
  inputMigracaoLinkPlanilha.classList.remove("input-travado");
  btnCriarPlanilhaMigracao.classList.remove("hidden");
  btnLiberarLinkPlanilha.classList.add("hidden");
  migracaoPlanilhaSubstituir = true;
  inputMigracaoLinkPlanilha.focus();
});

formMigracao.addEventListener("submit", async (e) => {
  e.preventDefault();
  // IdCentral é obrigatório pra todo cliente de migração — é o que liga esse
  // cadastro à Ficha do Cliente (Implantação). Só não vale quando o campo nem
  // aparece (config de uma migração pendurada num cliente que já tem Ficha —
  // abrirConfigMigracaoCliente esconde o wrap porque aí o IdCentral já vem de
  // lá, não dessa tela).
  if (!el("migracao-idcentral-wrap").classList.contains("hidden") && !inputMigracaoIdcentral.value.trim()) {
    inputMigracaoIdcentral.focus();
    return;
  }
  if (migracaoConfigModoCriar) {
    const nome = inputMigracaoNome.value.trim();
    if (!nome) {
      inputMigracaoNome.focus();
      return;
    }
    const idcentral = inputMigracaoIdcentral.value.trim();

    // Todo cliente de Migração vive no modelo único (clientes + migracoes) —
    // nunca cria mais na coleção solta antiga. Primeiro checa se o IdCentral
    // já é de um cliente de Implantação (GET /api/ficha/<idcentral> é o mesmo
    // lookup que a Ficha usa).
    let existente = null;
    try {
      const rFicha = await fetch(`/api/ficha/${encodeURIComponent(idcentral)}`);
      const dataFicha = await parseJsonResponse(rFicha);
      if (dataFicha.ok) existente = dataFicha.implantacao;
    } catch (err) {
      return alert(`Erro ao checar IdCentral: ${String(err)}`);
    }

    if (existente) {
      const vincular = await confirmarVincularMigracao(existente.cliente || idcentral);
      if (!vincular) {
        alert('Cliente não criado — para evitar clientes duplicados, não é possível criar esse cliente com o mesmo IdCentral de um já existente na Implantação.');
        return;
      }
      try {
        const rIniciar = await fetch(`/api/clientes/${existente.id}/migracoes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const dataIniciar = await parseJsonResponse(rIniciar);
        if (!dataIniciar.ok) return alert(`Erro ao vincular migração: ${dataIniciar.error || "falha desconhecida"}`);
        migracaoConfigBaseUrl = `/api/clientes/${existente.id}/migracoes/${dataIniciar.migracao.id}`;
      } catch (err) {
        return alert(`Erro ao vincular migração: ${String(err)}`);
      }
    } else {
      try {
        const rCriar = await fetch("/api/clientes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idcentral, cliente: nome, csm: inputMigracaoCs.value.trim(), tem_implantacao: false,
          }),
        });
        const dataCriar = await parseJsonResponse(rCriar);
        if (!dataCriar.ok) return alert(`Erro ao criar cliente: ${dataCriar.error || "falha desconhecida"}`);
        const rIniciar = await fetch(`/api/clientes/${dataCriar.cliente.id}/migracoes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const dataIniciar = await parseJsonResponse(rIniciar);
        if (!dataIniciar.ok) return alert(`Erro ao iniciar migração: ${dataIniciar.error || "falha desconhecida"}`);
        migracaoConfigBaseUrl = `/api/clientes/${dataCriar.cliente.id}/migracoes/${dataIniciar.migracao.id}`;
      } catch (err) {
        return alert(`Erro ao criar cliente: ${String(err)}`);
      }
    }
  }
  if (!migracaoConfigBaseUrl) return;
  const payload = {
    idcentral: inputMigracaoIdcentral.value.trim(),
    cs: inputMigracaoCs.value.trim(),
    etapa: inputMigracaoEtapa.value,
    plataforma_origem: inputMigracaoPlataforma.value.trim(),
    link_acesso_origem: inputMigracaoLinkAcessoOrigem.value.trim(),
    login_acesso_origem: inputMigracaoLoginAcessoOrigem.value.trim(),
    senha_acesso_origem: inputMigracaoSenhaAcessoOrigem.value,
    link_planilha: inputMigracaoLinkPlanilha.value.trim(),
    qtd_clientes: inputMigracaoQtdClientes.value,
    qtd_placas: inputMigracaoQtdPlacas.value,
    percentual_migracao: inputMigracaoPercentual.value,
  };
  try {
    const r = await fetch(migracaoConfigBaseUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao salvar: ${data.error || "falha desconhecida"}`);
    overlayMigracao.classList.add("hidden");
    fichaConfigContexto = null;
    migracaoConfigModoCriar = false;
    if (migracaoConfigModoNovo) {
      if (fichaClienteAtual && fichaClienteAtual.idcentral) {
        await carregarFichaCliente(fichaClienteAtual.idcentral);
        mostrarFichaAba("migracao");
      }
    } else {
      await carregarClientesMigracao();
    }
  } catch (err) {
    alert(`Erro ao salvar: ${String(err)}`);
  }
});

// --- MODELOS DE RASTREADOR POR CLIENTE (padroniza o Comando pelo Equipamento) ---
const migracaoModelosLista = el("migracao-modelos-lista");
const formMigracaoModelo = el("form-migracao-modelo");
const inputMigracaoModeloNome = el("migracao-modelo-nome");
const inputMigracaoModeloPorta = el("migracao-modelo-porta");
const inputMigracaoModeloComando = el("migracao-modelo-comando");
const btnSalvarMigracaoModelo = el("btn-salvar-migracao-modelo");
const btnCancelarEdicaoMigracaoModelo = el("btn-cancelar-edicao-migracao-modelo");

let migracaoModeloEditandoId = null;

function resolverComandoModelo(template, porta) {
  return (template || "").replace("{porta}", porta || "");
}

async function carregarMigracaoModelos() {
  if (!migracaoConfigBaseUrl) return;
  try {
    const r = await fetch(`${migracaoConfigBaseUrl}/modelos`);
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroEmNode(migracaoModelosLista, data.error || "Falha ao carregar modelos.");
    veiculosMigracaoModelosCache = data.modelos || [];
    renderMigracaoModelosLista();
  } catch (err) {
    mostrarErroEmNode(migracaoModelosLista, String(err));
  }
}

function renderMigracaoModelosLista() {
  migracaoModelosLista.innerHTML = "";
  if (veiculosMigracaoModelosCache.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nenhum modelo cadastrado ainda.";
    migracaoModelosLista.appendChild(p);
    return;
  }

  const table = document.createElement("table");
  table.className = "tabela-credenciais";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Modelo</th><th>Porta</th><th>Comando</th><th></th></tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  veiculosMigracaoModelosCache.forEach((m) => {
    const tr = document.createElement("tr");

    const tdModelo = document.createElement("td");
    tdModelo.textContent = m.modelo;

    const tdPorta = document.createElement("td");
    tdPorta.textContent = m.porta || "-";

    const tdComando = document.createElement("td");
    tdComando.textContent = m.comando_template || "-";
    tdComando.className = "comando-item-valor";

    const tdAcoes = document.createElement("td");
    tdAcoes.className = "acoes-credencial";

    const btnEditar = document.createElement("button");
    btnEditar.className = "btn-secondary";
    btnEditar.textContent = "Editar";
    btnEditar.addEventListener("click", () => abrirEdicaoMigracaoModelo(m));
    tdAcoes.appendChild(btnEditar);

    const btnExcluir = document.createElement("button");
    btnExcluir.className = "btn-secondary";
    btnExcluir.textContent = "Excluir";
    btnExcluir.addEventListener("click", () => excluirMigracaoModelo(m.id));
    tdAcoes.appendChild(btnExcluir);

    tr.appendChild(tdModelo);
    tr.appendChild(tdPorta);
    tr.appendChild(tdComando);
    tr.appendChild(tdAcoes);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  migracaoModelosLista.appendChild(table);
}

function resetFormMigracaoModelo() {
  formMigracaoModelo.reset();
  migracaoModeloEditandoId = null;
  btnSalvarMigracaoModelo.textContent = "Adicionar";
  btnCancelarEdicaoMigracaoModelo.classList.add("hidden");
  el("migracao-modelo-status").textContent = "";
}

function abrirEdicaoMigracaoModelo(m) {
  inputMigracaoModeloNome.value = m.modelo;
  inputMigracaoModeloPorta.value = m.porta || "";
  inputMigracaoModeloComando.value = m.comando_template || "";
  migracaoModeloEditandoId = m.id;
  btnSalvarMigracaoModelo.textContent = "Salvar edição";
  btnCancelarEdicaoMigracaoModelo.classList.remove("hidden");
  inputMigracaoModeloNome.focus();
}

btnCancelarEdicaoMigracaoModelo.addEventListener("click", resetFormMigracaoModelo);

formMigracaoModelo.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!migracaoConfigBaseUrl) return;
  const payload = {
    modelo: inputMigracaoModeloNome.value.trim(),
    porta: inputMigracaoModeloPorta.value.trim(),
    comando_template: inputMigracaoModeloComando.value.trim(),
  };
  if (!payload.modelo) return;
  try {
    const url = migracaoModeloEditandoId
      ? `${migracaoConfigBaseUrl}/modelos/${migracaoModeloEditandoId}`
      : `${migracaoConfigBaseUrl}/modelos`;
    const method = migracaoModeloEditandoId ? "PUT" : "POST";
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao salvar modelo: ${data.error || "falha desconhecida"}`);
    resetFormMigracaoModelo();
    await carregarMigracaoModelos();
    const migracaoModeloStatus = el("migracao-modelo-status");
    if (data.veiculos_atualizados > 0) {
      migracaoModeloStatus.textContent = `Comando atualizado em ${data.veiculos_atualizados} veículo(s) já cadastrado(s) com esse modelo.`;
    } else {
      migracaoModeloStatus.textContent = "";
    }
  } catch (err) {
    alert(`Erro ao salvar modelo: ${String(err)}`);
  }
});

async function excluirMigracaoModelo(id) {
  if (!migracaoConfigBaseUrl) return;
  if (!confirm("Excluir este modelo?")) return;
  try {
    const r = await fetch(`${migracaoConfigBaseUrl}/modelos/${id}`, { method: "DELETE" });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao excluir: ${data.error || "falha desconhecida"}`);
    await carregarMigracaoModelos();
  } catch (err) {
    alert(`Erro ao excluir: ${String(err)}`);
  }
}

// --- VEÍCULOS DO CLIENTE EM MIGRAÇÃO ---
const overlayVeiculosMigracao = el("overlay-veiculos-migracao");
const veiculosMigracaoTitulo = el("veiculos-migracao-titulo");
const veiculosMigracaoCorpo = el("veiculos-migracao-corpo");
const btnEnviarSelecionados = el("veiculos-migracao-enviar-selecionados");
const btnSelecionarTodosVeiculos = el("veiculos-migracao-selecionar-todos");
const veiculosMigracaoEnvioStatus = el("veiculos-migracao-envio-status");
const inputVeiculosMigracaoBusca = el("veiculos-migracao-busca");
const chipsVeiculosMigracaoStatus = el("veiculos-migracao-chips-status");

const STATUS_VEICULO_OPCOES = ["Aguardando", "Enviar", "Enviado", "Migrado", "Cancelado"];
const STATUS_VEICULO_CLASSE = {
  Aguardando: "linha-status-aguardando",
  Enviar: "linha-status-enviar",
  Enviado: "linha-status-enviado",
  Migrado: "linha-status-migrado",
  Cancelado: "linha-status-cancelado",
};
// Caminho base da API pra essa tela — muda conforme de onde ela foi aberta:
// tela antiga de Migração solta (/api/migracao/clientes/<id>) ou a tentativa
// nova pendurada num cliente (/api/clientes/<id>/migracoes/<id>). Toda a lógica
// de edição estilo planilha abaixo usa só essa variável, nunca um id direto —
// é o que permite as duas telas reaproveitarem o mesmo módulo sem duplicar nada.
let veiculosMigracaoBaseUrl = null;
let veiculosMigracaoClienteIdAtual = null; // só de referência/depuração; não usado em nenhuma URL
let veiculosMigracaoDadosAtuais = [];
let veiculosMigracaoFiltroTexto = "";
let veiculosMigracaoFiltroStatus = ""; // "" = todos

el("veiculos-migracao-fechar").addEventListener("click", () => overlayVeiculosMigracao.classList.add("hidden"));
async function carregarModelosCacheParaVeiculos(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/modelos`);
    const data = await parseJsonResponse(r);
    veiculosMigracaoModelosCache = data.ok ? (data.modelos || []) : [];
  } catch (err) {
    veiculosMigracaoModelosCache = [];
  }
}

async function abrirVeiculosPorBaseUrl(baseUrl, clienteId, titulo) {
  veiculosMigracaoBaseUrl = baseUrl;
  veiculosMigracaoClienteIdAtual = clienteId;
  veiculosMigracaoTitulo.textContent = `Veículos — ${titulo}`;
  veiculosMigracaoCorpo.innerHTML = '<p class="placeholder">Carregando...</p>';
  veiculosMigracaoEnvioStatus.textContent = "";
  btnSelecionarTodosVeiculos.textContent = "Selecionar todos";
  veiculosMigracaoFiltroTexto = "";
  veiculosMigracaoFiltroStatus = "";
  inputVeiculosMigracaoBusca.value = "";
  overlayVeiculosMigracao.classList.remove("hidden");
  await carregarModelosCacheParaVeiculos(baseUrl);
  await recarregarVeiculosMigracao(true);
}

// Ponto de entrada da tela de Migração — roteia pro container certo conforme
// a origem do item (ver GET /api/migracao/clientes): "legado" ainda mora na
// coleção solta antiga, "unificado" é uma tentativa pendurada num cliente de
// verdade (mesmo container que abrirVeiculosCliente já usa).
async function abrirVeiculosMigracao(cliente) {
  if (cliente.origem === "unificado") {
    await abrirVeiculosCliente(cliente.cliente_id, cliente.migracao_id, cliente.nome);
    return;
  }
  await abrirVeiculosPorBaseUrl(`/api/migracao/clientes/${cliente.id}`, cliente.id, cliente.nome);
}

// Ponto de entrada novo: uma tentativa de migração pendurada num cliente da
// lista única (Ficha do Cliente > Migração).
async function abrirVeiculosCliente(clienteId, migracaoId, nomeCliente) {
  await abrirVeiculosPorBaseUrl(`/api/clientes/${clienteId}/migracoes/${migracaoId}`, clienteId, nomeCliente);
}

let contadorLinhaBrancoVeiculo = 0;

function criarLinhaBrancoVeiculo() {
  contadorLinhaBrancoVeiculo += 1;
  return {
    id: `novo-${contadorLinhaBrancoVeiculo}`,
    cliente: "", veiculo: "", equipamento: "", id_equipamento: "", apn: "", ls_apn: "", numero_linha: "", comando: "",
    ultima_comunicacao: "", status: "Aguardando",
  };
}

async function recarregarVeiculosMigracao(permitirLinhasBranco = false) {
  try {
    const r = await fetch(`${veiculosMigracaoBaseUrl}/veiculos`);
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      veiculosMigracaoCorpo.innerHTML = "";
      return alert(`Erro ao carregar veículos: ${data.error || "falha desconhecida"}`);
    }
    if (data.veiculos.length === 0 && permitirLinhasBranco) {
      // Só gera linhas em branco na abertura inicial. Depois de um salvamento,
      // se vier vazio (falha real ou instabilidade de rede), mostramos vazio
      // mesmo — nunca substituímos dados recém-digitados por linhas em branco.
      veiculosMigracaoDadosAtuais = Array.from({ length: 10 }, criarLinhaBrancoVeiculo);
    } else {
      veiculosMigracaoDadosAtuais = data.veiculos;
    }
    renderTabelaVeiculosMigracao(veiculosMigracaoClienteIdAtual, veiculosMigracaoDadosAtuais);
  } catch (err) {
    alert(`Erro ao carregar veículos: ${String(err)}`);
  }
}

// --- Contagem "Migrado/Total" por cliente (equivalente à fórmula da planilha) e
// qtd_clientes/qtd_placas do card do projeto — tudo calculado no navegador a partir de
// veiculosMigracaoDadosAtuais (já carregado por inteiro), sem reler a subcoleção.
function calcularContagensPorCliente(veiculos) {
  const mapa = {};
  veiculos.forEach((v) => {
    if (!v.cliente) return;
    if (!mapa[v.cliente]) mapa[v.cliente] = { migrado: 0, total: 0 };
    mapa[v.cliente].total += 1;
    if (v.status === "Migrado") mapa[v.cliente].migrado += 1;
  });
  return mapa;
}

function atualizarContadoresClientes() {
  const mapa = calcularContagensPorCliente(veiculosMigracaoDadosAtuais);
  veiculosMigracaoCorpo.querySelectorAll("tbody tr").forEach((tr) => {
    const v = veiculosMigracaoDadosAtuais.find((item) => item.id === tr.dataset.veiculoId);
    const badge = tr.querySelector(".veiculo-contagem-cliente");
    if (!v || !badge) return;
    const info = v.cliente ? mapa[v.cliente] : null;
    badge.textContent = info ? ` (${info.migrado}/${info.total})` : "";
  });
}

function sincronizarContagensClienteMigracao() {
  const clientes = new Set();
  const placas = new Set();
  veiculosMigracaoDadosAtuais.forEach((v) => {
    if (v.cliente) clientes.add(v.cliente);
    if (v.veiculo) placas.add(v.veiculo);
  });
  fetch(veiculosMigracaoBaseUrl, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qtd_clientes: clientes.size, qtd_placas: placas.size }),
  }).catch(() => {}); // fire-and-forget: não bloqueia a edição por instabilidade de rede
}

// Autosave de um campo simples num veículo que já existe (id real) — PUT único, sem
// reler nada. Em linha ainda não salva (id "novo-N"), não há doc pra atualizar: ignora.
async function autosaveCampoSimples(tr, campo, valorNovo, rotulo) {
  if (String(tr.dataset.veiculoId).startsWith("novo-")) return false;
  try {
    const r = await fetch(`${veiculosMigracaoBaseUrl}/veiculos/${tr.dataset.veiculoId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [campo]: valorNovo }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      alert(`Erro ao salvar ${rotulo}: ${data.error || "falha desconhecida"}`);
      return false;
    }
    const registro = veiculosMigracaoDadosAtuais.find((item) => item.id === tr.dataset.veiculoId);
    if (registro) registro[campo] = valorNovo;
    return true;
  } catch (err) {
    alert(`Erro ao salvar ${rotulo}: ${String(err)}`);
    return false;
  }
}

// Cria ou renomeia (upsert) o veículo da linha — usado quando Cliente/Veículo mudam,
// já que isso muda a identidade do documento. Envia o snapshot completo da linha (tudo
// que já foi digitado nos outros campos) pra não perder nada digitado antes de existir.
async function salvarItemVeiculo(tr) {
  const idAntigo = tr.dataset.veiculoId;
  const eraNovo = String(idAntigo).startsWith("novo-");
  const item = { id: idAntigo };
  ["cliente", "veiculo", "equipamento", "id_equipamento", "apn", "ls_apn", "numero_linha", "ultima_comunicacao"].forEach((campo) => {
    const input = tr.querySelector(`[data-campo="${campo}"]`);
    item[campo] = input ? input.value.trim() : "";
  });
  const inputComando = tr.querySelector('[data-campo="comando"]');
  item.comando = inputComando ? inputComando.value : "";

  try {
    const r = await fetch(`${veiculosMigracaoBaseUrl}/veiculos/item`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao salvar veículo: ${data.error || "falha desconhecida"}`);

    const registro = veiculosMigracaoDadosAtuais.find((v) => v.id === idAntigo);
    if (registro) {
      Object.assign(registro, data.veiculo);
    } else {
      veiculosMigracaoDadosAtuais.push(data.veiculo);
    }
    tr.dataset.veiculoId = data.veiculo.id;

    const selectStatus = tr.querySelector(".veiculo-status-select");
    if (selectStatus) {
      selectStatus.disabled = false;
      selectStatus.title = "";
      selectStatus.value = data.veiculo.status || "Aguardando";
    }
    tr.className = STATUS_VEICULO_CLASSE[data.veiculo.status] || "";

    atualizarContadoresClientes();
    if (eraNovo) sincronizarContagensClienteMigracao();
  } catch (err) {
    alert(`Erro ao salvar veículo: ${String(err)}`);
  }
}

async function excluirLinhaVeiculo(tr) {
  const id = tr.dataset.veiculoId;
  const linhaNaoSalva = String(id).startsWith("novo-");
  if (!linhaNaoSalva) {
    try {
      const r = await fetch(`${veiculosMigracaoBaseUrl}/veiculos/${id}`, { method: "DELETE" });
      const data = await parseJsonResponse(r);
      if (!data.ok) return alert(`Erro ao excluir: ${data.error || "falha desconhecida"}`);
    } catch (err) {
      return alert(`Erro ao excluir: ${String(err)}`);
    }
  }
  veiculosMigracaoDadosAtuais = veiculosMigracaoDadosAtuais.filter((item) => item.id !== id);
  tr.remove();
  if (veiculosMigracaoDadosAtuais.length === 0) {
    renderTabelaVeiculosMigracao(veiculosMigracaoClienteIdAtual, veiculosMigracaoDadosAtuais);
  } else {
    atualizarContadoresClientes();
  }
  if (!linhaNaoSalva) sincronizarContagensClienteMigracao();
}

// Deixa TODAS as colunas de uma tabela redimensionáveis arrastando a borda do
// cabeçalho (não só uma coluna específica) — largura de cada uma fica salva no
// navegador (localStorage) por chaveArmazenamento, pra continuar do jeito que a
// pessoa deixou da próxima vez que abrir essa tabela.
// Idempotente de propósito (pode chamar de novo a cada vez que o <tbody> for
// reconstruído, tipo paginação/filtro — não duplica alça nem listener; a alça
// sempre lê as linhas atuais da tabela na hora do arrasto, não uma lista presa
// do momento em que foi criada).
// `larguraFixaPorIndice` ({indice: px}, opcional): colunas que NUNCA mudam
// de largura (nem por arrasto, nem por localStorage) — sem alça de
// redimensionar. Usado pelas colunas congeladas "Linha"/"Problema" do
// Conversor de Veículos, cujo "left" no CSS é um valor fixo (precisa que a
// largura seja sempre a mesma, senão a 2ª coluna desalinha).
function tornarColunasRedimensionaveis(table, chaveArmazenamento, larguraFixaPorIndice) {
  larguraFixaPorIndice = larguraFixaPorIndice || {};
  const ths = Array.from(table.querySelectorAll("thead th"));
  let larguras = {};
  try {
    larguras = JSON.parse(localStorage.getItem(chaveArmazenamento) || "{}");
  } catch (err) {
    larguras = {};
  }

  // table-layout:fixed faz cada coluna respeitar exatamente a largura do th
  // (em vez do navegador recalcular pelo conteúdo). Mas só funciona de verdade
  // se TODA coluna tiver uma largura explícita e ESTÁVEL: se uma ficar "solta"
  // (sem largura nossa), o navegador reescala ela toda vez que outra coluna
  // muda — e como a gente lia offsetWidth pra somar o total, isso virava um
  // loop de realimentação (a largura "oficial" de cada coluna ficava deriva,
  // ver investigação em `git log`). Por isso cada largura mora só aqui dentro
  // (`larguraAtual`), nunca mais lida de volta do DOM depois de aplicada.
  table.style.tableLayout = "fixed";
  // offsetWidth só é confiável aqui se a tabela já tiver uma largura própria
  // definida — sem isso, um <table> largura "auto" se espalha pelo contêiner
  // disponível (podendo inflar MUITO além do que faz sentido) antes da gente
  // conseguir travar o total. Por isso prioriza a largura que o th já veio com
  // (quem montou o cabeçalho pode ter definido um padrão, ex. 180px) e só cai
  // pro offsetWidth (real, mas potencialmente inflado) como último recurso.
  const larguraDoEstilo = (th) => {
    const n = parseFloat(th.style.width);
    return Number.isFinite(n) ? n : null;
  };
  const larguraAtual = {};
  ths.forEach((th, i) => {
    larguraAtual[i] = larguraFixaPorIndice[i] !== undefined
      ? larguraFixaPorIndice[i]
      : (larguras[i] || larguraDoEstilo(th) || th.offsetWidth || 140);
  });

  const aplicarLargura = (i, px) => {
    larguraAtual[i] = px;
    if (ths[i]) ths[i].style.width = `${px}px`;
    table.querySelectorAll("tbody tr").forEach((tr) => {
      if (tr.children[i]) tr.children[i].style.width = `${px}px`;
    });
  };
  const atualizarLarguraTotal = () => {
    table.style.width = `${ths.reduce((soma, _, i) => soma + larguraAtual[i], 0)}px`;
  };

  ths.forEach((th, i) => {
    aplicarLargura(i, larguraAtual[i]);
    if (larguraFixaPorIndice[i] !== undefined) return; // largura fixa — sem alça de redimensionar
    if (th.querySelector(".col-resize-handle")) return; // já tem alça dessa vez
    th.classList.add("th-redimensionavel");
    const alca = document.createElement("span");
    alca.className = "col-resize-handle";
    alca.title = "Arraste para redimensionar";
    th.appendChild(alca);
    // O "click" sintético que o navegador dispara depois do mouseup é um evento
    // À PARTE do mousedown — stopPropagation() no mousedown não o alcança, por
    // isso precisa barrar os dois pra não deixar o th com onClick (ex.: ordenar)
    // disparar sem querer logo depois de um arrasto.
    alca.addEventListener("click", (e) => e.stopPropagation());
    alca.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = larguraAtual[i];
      function aoMover(ev) {
        aplicarLargura(i, Math.max(40, startWidth + (ev.clientX - startX)));
        atualizarLarguraTotal();
      }
      function aoSoltar() {
        document.removeEventListener("mousemove", aoMover);
        document.removeEventListener("mouseup", aoSoltar);
        larguras[i] = larguraAtual[i];
        localStorage.setItem(chaveArmazenamento, JSON.stringify(larguras));
      }
      document.addEventListener("mousemove", aoMover);
      document.addEventListener("mouseup", aoSoltar);
    });
  });
  atualizarLarguraTotal();
}

function renderTabelaVeiculosMigracao(clienteId, veiculos) {
  veiculosMigracaoCorpo.innerHTML = "";

  if (veiculos.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nenhum veículo cadastrado para esse cliente ainda.";
    veiculosMigracaoCorpo.appendChild(p);
    return;
  }

  const headers = ["", "Status", "Cliente", "Veículo", "Equipamento", "ID do equipamento", "APN", "L/S apn", "Número da linha", "Comando", "Última comunicação", "Ações"];
  const table = document.createElement("table");
  table.className = "tabela-saida";

  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  // Campo de texto simples, sempre editável, autosave via PUT ao sair da célula
  // (ignorado em silêncio se a linha ainda não tiver um id real — ver autosaveCampoSimples).
  function criarCampoTexto(tr, v, campo, rotulo) {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "veiculo-comando-input";
    input.dataset.campo = campo;
    input.placeholder = rotulo;
    input.value = v[campo] || "";
    let ultimoValorSalvo = input.value;
    input.addEventListener("blur", async () => {
      if (input.value === ultimoValorSalvo) return;
      const ok = await autosaveCampoSimples(tr, campo, input.value, rotulo);
      if (ok) ultimoValorSalvo = input.value;
    });
    td.appendChild(input);
    return td;
  }

  // Cliente/Veículo: ao sair da célula, se os dois estiverem preenchidos, cria ou
  // renomeia o veículo (salvarItemVeiculo) — é o que muda a identidade do documento.
  function criarCampoClienteOuVeiculo(tr, v, campo) {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "veiculo-comando-input";
    input.dataset.campo = campo;
    input.value = v[campo] || "";
    let ultimoValorSalvo = input.value;
    input.addEventListener("blur", async () => {
      if (input.value === ultimoValorSalvo) return;
      const inputCliente = tr.querySelector('[data-campo="cliente"]');
      const inputVeiculo = tr.querySelector('[data-campo="veiculo"]');
      const cliente = inputCliente ? inputCliente.value.trim() : "";
      const veiculo = inputVeiculo ? inputVeiculo.value.trim() : "";
      if (!cliente || !veiculo) return;
      await salvarItemVeiculo(tr);
      ultimoValorSalvo = input.value;
    });
    td.appendChild(input);
    return td;
  }

  const tbody = document.createElement("tbody");
  veiculos.forEach((v) => {
    const tr = document.createElement("tr");
    tr.dataset.veiculoId = v.id;
    const statusAtual = v.status || "Aguardando";
    tr.className = STATUS_VEICULO_CLASSE[statusAtual] || "";

    const tdCheck = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "veiculo-checkbox";
    tdCheck.appendChild(checkbox);
    tr.appendChild(tdCheck);

    const linhaNaoSalva = String(v.id).startsWith("novo-");

    const tdStatus = document.createElement("td");
    const selectStatus = document.createElement("select");
    selectStatus.className = "veiculo-status-select";
    STATUS_VEICULO_OPCOES.forEach((opcao) => {
      const opt = document.createElement("option");
      opt.value = opcao;
      opt.textContent = opcao;
      if (opcao === statusAtual) opt.selected = true;
      selectStatus.appendChild(opt);
    });
    if (linhaNaoSalva) {
      selectStatus.disabled = true;
      selectStatus.title = "Preencha Cliente e Veículo primeiro";
    }
    selectStatus.addEventListener("change", async () => {
      const novoStatus = selectStatus.value;
      const ok = await autosaveCampoSimples(tr, "status", novoStatus, "status");
      if (ok) {
        tr.className = STATUS_VEICULO_CLASSE[novoStatus] || "";
        atualizarContadoresClientes();
        renderChipsStatusVeiculos();
        aplicarFiltrosVeiculos();
      }
    });
    tdStatus.appendChild(selectStatus);
    tr.appendChild(tdStatus);

    const tdCliente = criarCampoClienteOuVeiculo(tr, v, "cliente");
    const badgeContagem = document.createElement("span");
    badgeContagem.className = "veiculo-contagem-cliente";
    tdCliente.appendChild(badgeContagem);
    tr.appendChild(tdCliente);

    tr.appendChild(criarCampoClienteOuVeiculo(tr, v, "veiculo"));

    // Referência preenchida mais abaixo, quando a célula de Comando é montada —
    // o select de Equipamento (criado a seguir) usa isso pra autopreencher ao trocar.
    let inputComandoRef = null;

    if (veiculosMigracaoModelosCache.length > 0) {
      const tdEquipamento = document.createElement("td");
      const select = document.createElement("select");
      select.className = "veiculo-comando-input";
      select.dataset.campo = "equipamento";
      const optVazia = document.createElement("option");
      optVazia.value = "";
      optVazia.textContent = "Selecione o modelo...";
      select.appendChild(optVazia);
      veiculosMigracaoModelosCache.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.modelo;
        opt.textContent = m.modelo;
        if (m.modelo === v.equipamento) opt.selected = true;
        select.appendChild(opt);
      });
      let ultimoEquipamentoSalvo = select.value;
      select.addEventListener("change", async () => {
        const modelo = veiculosMigracaoModelosCache.find((m) => m.modelo === select.value);
        if (modelo && inputComandoRef) {
          inputComandoRef.value = resolverComandoModelo(modelo.comando_template, modelo.porta);
        }
        if (select.value === ultimoEquipamentoSalvo) return;
        const ok = await autosaveCampoSimples(tr, "equipamento", select.value, "Equipamento");
        if (ok) ultimoEquipamentoSalvo = select.value;
      });
      tdEquipamento.appendChild(select);
      tr.appendChild(tdEquipamento);
    } else {
      tr.appendChild(criarCampoTexto(tr, v, "equipamento", "Equipamento"));
    }

    tr.appendChild(criarCampoTexto(tr, v, "id_equipamento", "ID do equipamento"));
    tr.appendChild(criarCampoTexto(tr, v, "apn", "APN"));
    tr.appendChild(criarCampoTexto(tr, v, "ls_apn", "L/S apn"));
    tr.appendChild(criarCampoTexto(tr, v, "numero_linha", "Número da linha"));

    const tdComando = document.createElement("td");
    const inputComando = document.createElement("textarea");
    inputComando.className = "veiculo-comando-input veiculo-comando-textarea";
    inputComando.dataset.campo = "comando";
    inputComando.rows = 2;
    inputComando.placeholder = "Digite o(s) comando(s)...";
    inputComando.value = v.comando || "";
    inputComandoRef = inputComando;
    let ultimoComandoSalvo = inputComando.value;
    inputComando.addEventListener("blur", async () => {
      if (inputComando.value === ultimoComandoSalvo) return;
      const ok = await autosaveCampoSimples(tr, "comando", inputComando.value, "comando");
      if (ok) ultimoComandoSalvo = inputComando.value;
    });
    tdComando.appendChild(inputComando);
    tr.appendChild(tdComando);

    tr.appendChild(criarCampoTexto(tr, v, "ultima_comunicacao", "Última comunicação"));

    const tdAcoes = document.createElement("td");
    tdAcoes.className = "acoes-credencial";

    const btnEnviar = document.createElement("button");
    btnEnviar.className = "btn-enviar-icone";
    btnEnviar.textContent = "➤";
    btnEnviar.title = "Enviar comando para essa linha";
    btnEnviar.addEventListener("click", async () => {
      const inputNumero = tr.querySelector('[data-campo="numero_linha"]');
      const numero = inputNumero ? inputNumero.value : v.numero_linha;
      const resultado = await enviarComandoLinhaVeiculo(btnEnviar, numero, inputComando.value);
      if (resultado.ok) {
        alert(`Comando enviado para ${numero}.\n\nResposta da SMS Market: ${resultado.resposta}`);
      } else {
        alert(`Falha ao enviar comando para ${numero || "(sem número)"}.\n\nErro: ${resultado.error}`);
      }
    });
    tdAcoes.appendChild(btnEnviar);

    const btnExcluirLinha = document.createElement("button");
    btnExcluirLinha.className = "btn-enviar-icone btn-excluir-linha";
    btnExcluirLinha.textContent = "🗑";
    btnExcluirLinha.title = "Excluir esse veículo";
    btnExcluirLinha.addEventListener("click", async () => {
      const descricao = `${v.veiculo || tr.querySelector('[data-campo="veiculo"]').value || "(sem placa)"}`;
      if (!confirm(`Excluir o veículo "${descricao}"? Essa ação não pode ser desfeita.`)) return;
      await excluirLinhaVeiculo(tr);
    });
    tdAcoes.appendChild(btnExcluirLinha);

    const btnAdicionarLinha = document.createElement("button");
    btnAdicionarLinha.className = "btn-enviar-icone btn-adicionar-linha";
    btnAdicionarLinha.textContent = "+";
    btnAdicionarLinha.title = "Adicionar nova linha";
    btnAdicionarLinha.addEventListener("click", () => {
      veiculosMigracaoDadosAtuais.push(criarLinhaBrancoVeiculo());
      renderTabelaVeiculosMigracao(clienteId, veiculosMigracaoDadosAtuais);
    });
    tdAcoes.appendChild(btnAdicionarLinha);

    tr.appendChild(tdAcoes);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  veiculosMigracaoCorpo.appendChild(table);
  tornarColunasRedimensionaveis(table, "larguraColunas_veiculosMigracao");
  atualizarContadoresClientes();
  renderChipsStatusVeiculos();
  aplicarFiltrosVeiculos();
}

// --- Busca + filtro por status (ver STATUS_VEICULO_OPCOES) — a tabela pode
// chegar com dezenas de linhas de uma importação da planilha, então precisa
// de um jeito de achar/isolar veículos sem rolar tudo. Filtra escondendo
// linhas (.hidden), não reconstruindo a tabela — preserva os listeners de
// autosave de cada célula já montados.
function renderChipsStatusVeiculos() {
  chipsVeiculosMigracaoStatus.innerHTML = "";
  const contagem = {};
  STATUS_VEICULO_OPCOES.forEach((s) => { contagem[s] = 0; });
  veiculosMigracaoDadosAtuais.forEach((v) => {
    const s = v.status || "Aguardando";
    if (s in contagem) contagem[s] += 1;
  });
  const opcoes = [["", "Todos", veiculosMigracaoDadosAtuais.length], ...STATUS_VEICULO_OPCOES.map((s) => [s, s, contagem[s]])];
  opcoes.forEach(([valor, rotulo, qtd]) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "veiculo-chip-status";
    if (valor) chip.classList.add(`chip-${valor.toLowerCase()}`);
    if (veiculosMigracaoFiltroStatus === valor) chip.classList.add("ativo");
    chip.textContent = `${rotulo} (${qtd})`;
    chip.addEventListener("click", () => {
      veiculosMigracaoFiltroStatus = veiculosMigracaoFiltroStatus === valor ? "" : valor;
      renderChipsStatusVeiculos();
      aplicarFiltrosVeiculos();
    });
    chipsVeiculosMigracaoStatus.appendChild(chip);
  });
}

function aplicarFiltrosVeiculos() {
  const filtro = normalizarBusca(veiculosMigracaoFiltroTexto);
  veiculosMigracaoCorpo.querySelectorAll("tbody tr").forEach((tr) => {
    const statusAtual = tr.querySelector(".veiculo-status-select")?.value || "";
    const bateStatus = !veiculosMigracaoFiltroStatus || statusAtual === veiculosMigracaoFiltroStatus;
    let bateTexto = true;
    if (filtro) {
      const partes = ["cliente", "veiculo", "equipamento"].map((campo) => {
        const input = tr.querySelector(`[data-campo="${campo}"]`);
        return input ? input.value : "";
      });
      bateTexto = normalizarBusca(partes.join(" ")).includes(filtro);
    }
    tr.classList.toggle("hidden", !(bateStatus && bateTexto));
  });
}

inputVeiculosMigracaoBusca.addEventListener("input", () => {
  veiculosMigracaoFiltroTexto = inputVeiculosMigracaoBusca.value;
  aplicarFiltrosVeiculos();
});

btnSelecionarTodosVeiculos.addEventListener("click", () => {
  const checkboxes = Array.from(veiculosMigracaoCorpo.querySelectorAll(".veiculo-checkbox"));
  if (checkboxes.length === 0) return;
  const todosMarcados = checkboxes.every((cb) => cb.checked);
  checkboxes.forEach((cb) => { cb.checked = !todosMarcados; });
  btnSelecionarTodosVeiculos.textContent = todosMarcados ? "Selecionar todos" : "Desmarcar todos";
});

async function enviarComandoLinhaVeiculo(botao, numeroLinha, comandoTexto) {
  const numero = (numeroLinha || "").trim();
  const conteudo = (comandoTexto || "").trim();
  if (!numero) return { ok: false, error: "Sem número de linha cadastrado." };
  if (!conteudo) return { ok: false, error: "Comando vazio." };

  if (botao) {
    botao.disabled = true;
    var textoOriginal = botao.textContent;
    botao.textContent = "...";
  }
  try {
    const r = await fetch("/api/comando/enviar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ numero, conteudo, campaign_id: "Comando avulso - migração" }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (botao) botao.title = data.error || "Falha ao enviar.";
      return { ok: false, error: data.error || "Falha ao enviar SMS." };
    }
    if (botao) botao.title = `Última resposta: ${data.resposta}`;
    return { ok: true, resposta: data.resposta };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    if (botao) {
      botao.disabled = false;
      botao.textContent = textoOriginal;
    }
  }
}

btnEnviarSelecionados.addEventListener("click", async () => {
  const linhas = Array.from(veiculosMigracaoCorpo.querySelectorAll("tbody tr")).filter(
    (tr) => tr.querySelector(".veiculo-checkbox")?.checked
  );
  if (linhas.length === 0) return alert("Marque ao menos um veículo pra enviar.");

  btnEnviarSelecionados.disabled = true;
  let sucessos = 0;
  let erros = 0;
  const detalhes = [];

  for (let i = 0; i < linhas.length; i++) {
    const tr = linhas[i];
    veiculosMigracaoEnvioStatus.textContent = `Enviando ${i + 1} de ${linhas.length}...`;
    const inputComando = tr.querySelector('[data-campo="comando"]');
    const campoNumero = tr.querySelector('[data-campo="numero_linha"]');
    const btnLinha = tr.querySelector(".btn-enviar-icone");
    const numeroLinha = campoNumero ? (campoNumero.value ?? campoNumero.textContent) || "" : "";
    const resultado = await enviarComandoLinhaVeiculo(btnLinha, numeroLinha, inputComando ? inputComando.value : "");
    if (resultado.ok) {
      sucessos++;
      detalhes.push(`✔ ${numeroLinha || "(sem número)"}: ${resultado.resposta}`);
    } else {
      erros++;
      detalhes.push(`✘ ${numeroLinha || "(sem número)"}: ${resultado.error}`);
    }
  }

  veiculosMigracaoEnvioStatus.textContent = `Concluído! Sucessos: ${sucessos} | Erros: ${erros}`;
  btnEnviarSelecionados.disabled = false;
  alert(`Envio em lote concluído.\nSucessos: ${sucessos} | Erros: ${erros}\n\n${detalhes.join("\n")}`);
});

async function abrirModalImport(tipo, idcentral) {
  estado.importTipo = tipo;
  // Sempre sobrescreve (nunca preserva um valor antigo) — esse modal é um
  // singleton reaproveitado tanto pela Ficha quanto por Ferramentas
  // Auxiliares, então um idcentral de uma Ficha anterior nunca pode vazar
  // pra um uso avulso seguinte (ou vice-versa).
  estado.importIdcentral = idcentral || null;
  estado.fileId = null;
  estado.colunas = [];
  estado.mapeamentoSugerido = null;
  inputArquivo.value = "";
  arquivoNome.textContent = "Nenhum arquivo selecionado";
  // Sempre volta pro modo "upload normal" — se a última abertura foi via
  // abrirModalImportDeConvcli() essa etapa ficou escondida.
  importPassoUpload.classList.remove("hidden");
  importPassoOrigemConvcli.classList.add("hidden");
  progressoContainer.classList.add("hidden");
  progressoBar.style.width = "0%";
  progressoPct.textContent = "0%";
  importLog.innerHTML = "";
  btnIniciarImport.disabled = true;
  btnIniciarImport.textContent = "Iniciar Importação";

  const r = await fetch(`/api/import/params/${tipo}`);
  const data = await parseJsonResponse(r);
  if (!data.ok) return mostrarErro(data.error || "Tipo desconhecido.");

  modalTitulo.textContent = `Mapeamento: ${data.titulo}`;
  estado.campos = data.campos;
  renderMapaCampos();
  overlay.classList.remove("hidden");
}

// Variante usada pelo botão "Importar via API" do Conversor de Clientes:
// em vez do passo 1 pedir upload de um Excel novo, reaproveita os registros
// JÁ carregados/mapeados/editados na própria tela (convcliFileId), convertidos
// no servidor pra um "upload" do modal genérico (ver
// /api/conversor-clientes/usar-como-upload). O resto do fluxo (passo 2 em
// diante) é idêntico ao abrirModalImport — mesmo mapeamento, mesma
// importação, mesmo polling.
async function abrirModalImportDeConvcli() {
  estado.importTipo = "cliente";
  estado.importIdcentral = null;
  estado.fileId = null;
  estado.colunas = [];
  estado.mapeamentoSugerido = null;
  importPassoUpload.classList.add("hidden");
  importPassoOrigemConvcli.classList.remove("hidden");
  progressoContainer.classList.add("hidden");
  progressoBar.style.width = "0%";
  progressoPct.textContent = "0%";
  importLog.innerHTML = "";
  btnIniciarImport.disabled = true;
  btnIniciarImport.textContent = "Iniciar Importação";

  const rParams = await fetch("/api/import/params/cliente");
  const dataParams = await parseJsonResponse(rParams);
  if (!dataParams.ok) return mostrarErroConvcli(dataParams.error || "Tipo desconhecido.");
  modalTitulo.textContent = `Mapeamento: ${dataParams.titulo}`;
  estado.campos = dataParams.campos;

  importOrigemConvcliTexto.textContent = "Carregando a planilha do Conversor de Clientes...";
  overlay.classList.remove("hidden");

  try {
    const rUsar = await fetch("/api/conversor-clientes/usar-como-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcliFileId }),
    });
    const dataUsar = await parseJsonResponse(rUsar);
    if (!dataUsar.ok) {
      overlay.classList.add("hidden");
      return mostrarErroConvcli(dataUsar.error || "Falha ao preparar os dados pra importação.");
    }
    estado.fileId = dataUsar.file_id;
    estado.colunas = dataUsar.colunas;
    estado.mapeamentoSugerido = dataUsar.mapeamento_sugerido || null;
    importOrigemConvcliTexto.textContent = `Usando a planilha do Conversor de Clientes (${dataUsar.total_linhas} linha(s))`;
    btnIniciarImport.disabled = false;
  } catch (err) {
    overlay.classList.add("hidden");
    return mostrarErroConvcli(String(err));
  }

  renderMapaCampos();
}

// Mesma ideia de abrirModalImportDeConvcli, mas pro Conversor de Veículos:
// reaproveita os registros já carregados/mapeados em convveiFileId (ver
// /api/conversor-veiculos/usar-como-upload) em vez de pedir upload de novo.
async function abrirModalImportDeConvvei() {
  estado.importTipo = "veiculo";
  estado.importIdcentral = null;
  estado.fileId = null;
  estado.colunas = [];
  estado.mapeamentoSugerido = null;
  importPassoUpload.classList.add("hidden");
  importPassoOrigemConvcli.classList.remove("hidden");
  progressoContainer.classList.add("hidden");
  progressoBar.style.width = "0%";
  progressoPct.textContent = "0%";
  importLog.innerHTML = "";
  btnIniciarImport.disabled = true;
  btnIniciarImport.textContent = "Iniciar Importação";

  const rParams = await fetch("/api/import/params/veiculo");
  const dataParams = await parseJsonResponse(rParams);
  if (!dataParams.ok) return mostrarErroConvvei(dataParams.error || "Tipo desconhecido.");
  modalTitulo.textContent = `Mapeamento: ${dataParams.titulo}`;
  estado.campos = dataParams.campos;

  importOrigemConvcliTexto.textContent = "Carregando a planilha do Conversor de Veículos...";
  overlay.classList.remove("hidden");

  try {
    const rUsar = await fetch("/api/conversor-veiculos/usar-como-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convveiFileId }),
    });
    const dataUsar = await parseJsonResponse(rUsar);
    if (!dataUsar.ok) {
      overlay.classList.add("hidden");
      return mostrarErroConvvei(dataUsar.error || "Falha ao preparar os dados pra importação.");
    }
    estado.fileId = dataUsar.file_id;
    estado.colunas = dataUsar.colunas;
    estado.mapeamentoSugerido = dataUsar.mapeamento_sugerido || null;
    importOrigemConvcliTexto.textContent = `Usando a planilha do Conversor de Veículos (${dataUsar.total_linhas} linha(s))`;
    btnIniciarImport.disabled = false;
  } catch (err) {
    overlay.classList.add("hidden");
    return mostrarErroConvvei(String(err));
  }

  renderMapaCampos();
}

// Mesma ideia de abrirModalImportDeConvvei, mas pro Conversor de
// Rastreadores: reaproveita os registros já carregados/mapeados em
// convrstFileId (ver /api/conversor-rastreadores/usar-como-upload).
async function abrirModalImportDeConvrst() {
  estado.importTipo = "rastreador";
  estado.importIdcentral = null;
  estado.fileId = null;
  estado.colunas = [];
  estado.mapeamentoSugerido = null;
  importPassoUpload.classList.add("hidden");
  importPassoOrigemConvcli.classList.remove("hidden");
  progressoContainer.classList.add("hidden");
  progressoBar.style.width = "0%";
  progressoPct.textContent = "0%";
  importLog.innerHTML = "";
  btnIniciarImport.disabled = true;
  btnIniciarImport.textContent = "Iniciar Importação";

  const rParams = await fetch("/api/import/params/rastreador");
  const dataParams = await parseJsonResponse(rParams);
  if (!dataParams.ok) return mostrarErroConvrst(dataParams.error || "Tipo desconhecido.");
  modalTitulo.textContent = `Mapeamento: ${dataParams.titulo}`;
  estado.campos = dataParams.campos;

  importOrigemConvcliTexto.textContent = "Carregando a planilha do Conversor de Rastreadores...";
  overlay.classList.remove("hidden");

  try {
    const rUsar = await fetch("/api/conversor-rastreadores/usar-como-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convrstFileId }),
    });
    const dataUsar = await parseJsonResponse(rUsar);
    if (!dataUsar.ok) {
      overlay.classList.add("hidden");
      return mostrarErroConvrst(dataUsar.error || "Falha ao preparar os dados pra importação.");
    }
    estado.fileId = dataUsar.file_id;
    estado.colunas = dataUsar.colunas;
    estado.mapeamentoSugerido = dataUsar.mapeamento_sugerido || null;
    importOrigemConvcliTexto.textContent = `Usando a planilha do Conversor de Rastreadores (${dataUsar.total_linhas} linha(s))`;
    btnIniciarImport.disabled = false;
  } catch (err) {
    overlay.classList.add("hidden");
    return mostrarErroConvrst(String(err));
  }

  renderMapaCampos();
}

// Mesma ideia de abrirModalImportDeConvvei, mas pro Conversor de SIM Cards:
// reaproveita os registros já carregados/mapeados em convsimFileId (ver
// /api/conversor-simcards/usar-como-upload).
async function abrirModalImportDeConvsim() {
  estado.importTipo = "simcard";
  estado.importIdcentral = null;
  estado.fileId = null;
  estado.colunas = [];
  estado.mapeamentoSugerido = null;
  importPassoUpload.classList.add("hidden");
  importPassoOrigemConvcli.classList.remove("hidden");
  progressoContainer.classList.add("hidden");
  progressoBar.style.width = "0%";
  progressoPct.textContent = "0%";
  importLog.innerHTML = "";
  btnIniciarImport.disabled = true;
  btnIniciarImport.textContent = "Iniciar Importação";

  const rParams = await fetch("/api/import/params/simcard");
  const dataParams = await parseJsonResponse(rParams);
  if (!dataParams.ok) return mostrarErroConvsim(dataParams.error || "Tipo desconhecido.");
  modalTitulo.textContent = `Mapeamento: ${dataParams.titulo}`;
  estado.campos = dataParams.campos;

  importOrigemConvcliTexto.textContent = "Carregando a planilha do Conversor de SIM Cards...";
  overlay.classList.remove("hidden");

  try {
    const rUsar = await fetch("/api/conversor-simcards/usar-como-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convsimFileId }),
    });
    const dataUsar = await parseJsonResponse(rUsar);
    if (!dataUsar.ok) {
      overlay.classList.add("hidden");
      return mostrarErroConvsim(dataUsar.error || "Falha ao preparar os dados pra importação.");
    }
    estado.fileId = dataUsar.file_id;
    estado.colunas = dataUsar.colunas;
    estado.mapeamentoSugerido = dataUsar.mapeamento_sugerido || null;
    importOrigemConvcliTexto.textContent = `Usando a planilha do Conversor de SIM Cards (${dataUsar.total_linhas} linha(s))`;
    btnIniciarImport.disabled = false;
  } catch (err) {
    overlay.classList.add("hidden");
    return mostrarErroConvsim(String(err));
  }

  renderMapaCampos();
}

// Mesma ideia de abrirModalImportDeConvvei, mas pro Conversor de Unidades
// Organizacionais: reaproveita os registros já carregados/mapeados em
// convuoFileId (ver /api/conversor-uo/usar-como-upload). Único Conversor
// onde este É o único caminho de conclusão (sem "Baixar arquivo" — a SSX
// não tem layout de arquivo pra Unidade Organizacional, só API).
// Mesma ideia de abrirModalImportDeConvrst, mas pro Conversor de
// Colaboradores: reaproveita os registros já carregados/mapeados em
// convcolFileId (ver /api/conversor-colaboradores/usar-como-upload).
async function abrirModalImportDeConvcol() {
  estado.importTipo = "colaborador";
  estado.importIdcentral = null;
  estado.fileId = null;
  estado.colunas = [];
  estado.mapeamentoSugerido = null;
  importPassoUpload.classList.add("hidden");
  importPassoOrigemConvcli.classList.remove("hidden");
  progressoContainer.classList.add("hidden");
  progressoBar.style.width = "0%";
  progressoPct.textContent = "0%";
  importLog.innerHTML = "";
  btnIniciarImport.disabled = true;
  btnIniciarImport.textContent = "Iniciar Importação";

  const rParams = await fetch("/api/import/params/colaborador");
  const dataParams = await parseJsonResponse(rParams);
  if (!dataParams.ok) return mostrarErroConvcol(dataParams.error || "Tipo desconhecido.");
  modalTitulo.textContent = `Mapeamento: ${dataParams.titulo}`;
  estado.campos = dataParams.campos;

  importOrigemConvcliTexto.textContent = "Carregando a planilha do Conversor de Colaboradores...";
  overlay.classList.remove("hidden");

  try {
    const rUsar = await fetch("/api/conversor-colaboradores/usar-como-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcolFileId }),
    });
    const dataUsar = await parseJsonResponse(rUsar);
    if (!dataUsar.ok) {
      overlay.classList.add("hidden");
      return mostrarErroConvcol(dataUsar.error || "Falha ao preparar os dados pra importação.");
    }
    estado.fileId = dataUsar.file_id;
    estado.colunas = dataUsar.colunas;
    estado.mapeamentoSugerido = dataUsar.mapeamento_sugerido || null;
    importOrigemConvcliTexto.textContent = `Usando a planilha do Conversor de Colaboradores (${dataUsar.total_linhas} linha(s))`;
    btnIniciarImport.disabled = false;
  } catch (err) {
    overlay.classList.add("hidden");
    return mostrarErroConvcol(String(err));
  }

  renderMapaCampos();
}

async function abrirModalImportDeConvuo() {
  estado.importTipo = "uo";
  estado.importIdcentral = null;
  estado.fileId = null;
  estado.colunas = [];
  estado.mapeamentoSugerido = null;
  importPassoUpload.classList.add("hidden");
  importPassoOrigemConvcli.classList.remove("hidden");
  progressoContainer.classList.add("hidden");
  progressoBar.style.width = "0%";
  progressoPct.textContent = "0%";
  importLog.innerHTML = "";
  btnIniciarImport.disabled = true;
  btnIniciarImport.textContent = "Iniciar Importação";

  const rParams = await fetch("/api/import/params/uo");
  const dataParams = await parseJsonResponse(rParams);
  if (!dataParams.ok) return mostrarErroConvuo(dataParams.error || "Tipo desconhecido.");
  modalTitulo.textContent = `Mapeamento: ${dataParams.titulo}`;
  estado.campos = dataParams.campos;

  importOrigemConvcliTexto.textContent = "Carregando a planilha do Conversor de Unidades Organizacionais...";
  overlay.classList.remove("hidden");

  try {
    const rUsar = await fetch("/api/conversor-uo/usar-como-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convuoFileId }),
    });
    const dataUsar = await parseJsonResponse(rUsar);
    if (!dataUsar.ok) {
      overlay.classList.add("hidden");
      return mostrarErroConvuo(dataUsar.error || "Falha ao preparar os dados pra importação.");
    }
    estado.fileId = dataUsar.file_id;
    estado.colunas = dataUsar.colunas;
    estado.mapeamentoSugerido = dataUsar.mapeamento_sugerido || null;
    importOrigemConvcliTexto.textContent = `Usando a planilha do Conversor de Unidades Organizacionais (${dataUsar.total_linhas} linha(s))`;
    btnIniciarImport.disabled = false;
  } catch (err) {
    overlay.classList.add("hidden");
    return mostrarErroConvuo(String(err));
  }

  renderMapaCampos();
}

async function abrirModalImportDeConvare() {
  estado.importTipo = "area";
  estado.importIdcentral = null;
  estado.fileId = null;
  estado.colunas = [];
  estado.mapeamentoSugerido = null;
  importPassoUpload.classList.add("hidden");
  importPassoOrigemConvcli.classList.remove("hidden");
  progressoContainer.classList.add("hidden");
  progressoBar.style.width = "0%";
  progressoPct.textContent = "0%";
  importLog.innerHTML = "";
  btnIniciarImport.disabled = true;
  btnIniciarImport.textContent = "Iniciar Importação";

  const rParams = await fetch("/api/import/params/area");
  const dataParams = await parseJsonResponse(rParams);
  if (!dataParams.ok) return mostrarErroConvare(dataParams.error || "Tipo desconhecido.");
  modalTitulo.textContent = `Mapeamento: ${dataParams.titulo}`;
  estado.campos = dataParams.campos;

  importOrigemConvcliTexto.textContent = "Carregando a planilha do Conversor de Áreas...";
  overlay.classList.remove("hidden");

  try {
    const rUsar = await fetch("/api/conversor-areas/usar-como-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convareFileId }),
    });
    const dataUsar = await parseJsonResponse(rUsar);
    if (!dataUsar.ok) {
      overlay.classList.add("hidden");
      return mostrarErroConvare(dataUsar.error || "Falha ao preparar os dados pra importação.");
    }
    estado.fileId = dataUsar.file_id;
    estado.colunas = dataUsar.colunas;
    estado.mapeamentoSugerido = dataUsar.mapeamento_sugerido || null;
    importOrigemConvcliTexto.textContent = `Usando a planilha do Conversor de Áreas (${dataUsar.total_linhas} linha(s))`;
    btnIniciarImport.disabled = false;
  } catch (err) {
    overlay.classList.add("hidden");
    return mostrarErroConvare(String(err));
  }

  renderMapaCampos();
}

// Normaliza pra comparação de nomes: sem acento, minúsculo, só letras/dígitos
// (espaço, pontuação etc. somem) — "Nome do Cliente" e "nome_cliente" batem igual.
function normalizarBlobMapeamento(txt) {
  return String(txt || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Preposições/conectivos que uma planilha pode omitir ou incluir sem mudar o
// sentido do nome do campo ("Código Integração Cliente" == "Código de
// integração do cliente") — removidas numa segunda comparação pra não perder
// esses casos só porque o blob bruto não bate como substring contíguo.
const MAPEAMENTO_STOPWORDS = new Set(["de", "do", "da", "dos", "das", "e"]);
function normalizarBlobSemStopwordsMapeamento(txt) {
  const semAcento = String(txt || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return semAcento
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !MAPEAMENTO_STOPWORDS.has(t))
    .join("");
}

// Pontua um par (rótulo do campo, nome da coluna): 100 = igual, 50-90 = um
// "contém" o outro (pontuado pela proporção do menor dentro do maior), 0 =
// sem relação. Compara tanto o blob bruto quanto o blob sem stopwords e usa o
// melhor dos dois, pra "Login" bater em "Login do Cliente" (bruto) e
// "Código Integração Cliente" bater em "Código de integração do cliente"
// (sem stopwords) ao mesmo tempo.
function pontuarParMapeamento(rotulo, coluna) {
  const pares = [
    [normalizarBlobMapeamento(rotulo), normalizarBlobMapeamento(coluna)],
    [normalizarBlobSemStopwordsMapeamento(rotulo), normalizarBlobSemStopwordsMapeamento(coluna)],
  ];
  let melhor = 0;
  pares.forEach(([a, b]) => {
    if (!a || !b) return;
    let score = 0;
    if (a === b) {
      score = 100;
    } else if (a.includes(b) || b.includes(a)) {
      const menor = Math.min(a.length, b.length);
      const maior = Math.max(a.length, b.length);
      score = 50 + Math.round((menor / maior) * 40);
    }
    if (score > melhor) melhor = score;
  });
  return melhor;
}

// Sugere, pra cada campo da API, a coluna da planilha com nome mais parecido
// (normalizado). Cada coluna só é usada numa sugestão (a de maior score), o
// resto fica "(Não mapeado)" — a pessoa ajusta/sobrescreve tudo depois, isso
// é só ponto de partida.
function sugerirMapeamentoAutomatico(campos, colunas) {
  const usadas = new Set();
  const sugestao = {};

  campos.forEach((campo) => {
    if (!campo.rotulo) return;
    let melhorCol = null;
    let melhorScore = 0;
    colunas.forEach((col) => {
      if (usadas.has(col)) return;
      const score = pontuarParMapeamento(campo.rotulo, col);
      if (score > melhorScore) {
        melhorScore = score;
        melhorCol = col;
      }
    });
    if (melhorCol && melhorScore >= 60) {
      sugestao[campo.nome] = melhorCol;
      usadas.add(melhorCol);
    }
  });

  return sugestao;
}

function renderMapaCampos() {
  mapaCampos.innerHTML = "";
  // estado.mapeamentoSugerido: mapeamento exato vindo do servidor (ver
  // abrirModalImportDeConvcli) — usado no lugar do auto-mapeamento por texto
  // quando a correspondência é de SIGNIFICADO, não de nome parecido (ex.
  // "Registro" = "IE / RG"), que o algoritmo abaixo nunca acertaria.
  const sugestoes = estado.mapeamentoSugerido || sugerirMapeamentoAutomatico(estado.campos, estado.colunas);
  estado.campos.forEach((campo) => {
    const linha = document.createElement("div");
    linha.className = "mapa-linha";

    const nome = document.createElement("span");
    nome.className = "campo-nome";
    nome.textContent = campo.rotulo;
    nome.title = campo.nome;

    const select = document.createElement("select");
    select.dataset.campo = campo.nome;
    const optVazio = document.createElement("option");
    optVazio.value = "";
    optVazio.textContent = "(Não mapeado)";
    select.appendChild(optVazio);
    estado.colunas.forEach((col) => {
      const opt = document.createElement("option");
      opt.value = col;
      opt.textContent = col;
      select.appendChild(opt);
    });
    if (sugestoes[campo.nome]) {
      select.value = sugestoes[campo.nome];
    }

    linha.appendChild(nome);
    linha.appendChild(select);
    mapaCampos.appendChild(linha);
  });
}

el("modal-fechar").addEventListener("click", () => overlay.classList.add("hidden"));
inputArquivo.addEventListener("change", async () => {
  const file = inputArquivo.files[0];
  if (!file) return;
  arquivoNome.textContent = "Enviando...";
  const formData = new FormData();
  formData.append("arquivo", file);
  try {
    const r = await fetch("/api/import/upload", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      arquivoNome.textContent = "Nenhum arquivo selecionado";
      return mostrarErro(data.error || "Falha ao enviar arquivo.");
    }
    estado.fileId = data.file_id;
    estado.colunas = data.colunas;
    arquivoNome.textContent = `${file.name} (${data.total_linhas} linhas)`;
    renderMapaCampos();
    btnIniciarImport.disabled = false;
  } catch (err) {
    arquivoNome.textContent = "Nenhum arquivo selecionado";
    mostrarErro(String(err));
  }
});

let importLogsMostrados = 0;
let importPollTimer = null;

function pararPollingImport() {
  if (importPollTimer) {
    clearInterval(importPollTimer);
    importPollTimer = null;
  }
}

function iniciarPollingImport(jobId, logContainer) {
  importPollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/import/run/status/${jobId}`);
      const job = await parseJsonResponse(r);
      if (!job.ok) {
        pararPollingImport();
        return mostrarErro(job.error || "Falha ao consultar andamento.");
      }

      const pct = job.total ? Math.min(Math.round((job.atual / job.total) * 100), 100) : 0;
      progressoBar.style.width = pct + "%";
      progressoPct.textContent = pct + "%";
      progressoStatus.textContent = `Processando ${job.atual} de ${job.total} (sucessos: ${job.sucessos}, erros: ${job.erros})`;

      for (let i = importLogsMostrados; i < job.logs.length; i++) {
        const linhaLog = document.createElement("div");
        linhaLog.className = "log-linha";
        linhaLog.textContent = job.logs[i];
        logContainer.appendChild(linhaLog);
      }
      importLogsMostrados = job.logs.length;

      if (job.status === "concluido") {
        pararPollingImport();

        const div = document.createElement("div");
        div.className = "resumo-final";
        div.textContent = `Concluído! Sucessos: ${job.sucessos} | Erros: ${job.erros}`;
        logContainer.appendChild(div);

        // Fica aberto mostrando o resultado — fecha só quando clicar em "Fechar".
        progressoStatus.textContent = `Concluído! Sucessos: ${job.sucessos} | Erros: ${job.erros}`;
        btnIniciarImport.disabled = true;
        btnIniciarImport.textContent = "Concluído — clique em Fechar";
      }
    } catch (err) {
      pararPollingImport();
      mostrarErro(String(err));
      btnIniciarImport.disabled = false;
      btnIniciarImport.textContent = "Iniciar Importação";
    }
  }, 1500);
}

btnIniciarImport.addEventListener("click", async () => {
  const mapping = {};
  mapaCampos.querySelectorAll("select").forEach((sel) => {
    if (sel.value) mapping[sel.dataset.campo] = sel.value;
  });
  if (Object.keys(mapping).length === 0) {
    return mostrarErro("Mapeie ao menos uma coluna antes de iniciar.");
  }

  btnIniciarImport.disabled = true;
  btnIniciarImport.textContent = "Importando...";
  progressoContainer.classList.remove("hidden");
  progressoBar.style.width = "0%";
  progressoPct.textContent = "0%";
  progressoStatus.textContent = "Iniciando...";

  // Log fica dentro do próprio modal (não mais em #saida) — #saida é uma
  // tela à parte que não aparece nem em Ferramentas Auxiliares nem na Ficha,
  // então o log ficava efetivamente escondido nos dois casos.
  importLog.innerHTML = "";
  const logContainer = importLog;
  importLogsMostrados = 0;

  try {
    const resp = await fetch("/api/import/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tipo: estado.importTipo,
        idcentral: estado.importIdcentral,
        file_id: estado.fileId,
        mapping,
      }),
    });
    const data = await parseJsonResponse(resp);
    if (!data.ok) throw new Error(data.error || "Falha ao iniciar importação.");
    iniciarPollingImport(data.job_id, logContainer);
  } catch (err) {
    mostrarErro(String(err));
    overlay.classList.add("hidden");
    btnIniciarImport.disabled = false;
    btnIniciarImport.textContent = "Iniciar Importação";
  }
});

// --- ENVIO DE COMANDO (SMS Market) ---
// Formulário fica direto na sub-tela "/ferramentas/comandos"; a engrenagem do cabeçalho
// abre o "Gerenciar modelos de comando" (modal).
const comandoModelo = el("comando-modelo");
const comandoTipo = el("comando-tipo");
const comandoOperadora = el("comando-operadora");
const comandoIdInput = el("comando-id");
const comandoApnInput = el("comando-apn");
const comandoLoginApnInput = el("comando-loginapn");
const comandoPortaInput = el("comando-porta");
const comandoPreview = el("comando-preview");
const comandoSaldo = el("comando-saldo");
const comandoResposta = el("comando-resposta");
const comandoArquivoNome = el("comando-arquivo-nome");
const btnComandoEnviarMassa = el("btn-comando-enviar-massa");
const comandoMassaProgresso = el("comando-massa-progresso");
const comandoMassaBar = el("comando-massa-bar");
const comandoMassaStatus = el("comando-massa-status");
const comandoMassaPct = el("comando-massa-pct");
const comandoMassaLog = el("comando-massa-log");

const MODELOS_RASTREADOR = [
  "E3/E3+", "F1/M1", "GTK LW", "GV-50", "GV-55", "GV-75", "ITR-120/155", "J16",
  "JC181", "JC400D", "JC400AD", "JC450", "VL01/02/03", "LV12", "MXT-140", "N4",
  "NT20", "Oneblock", "ST3XX", "ST40XX", "ST80XX", "TK311", "TR05",
];

const COMANDOS_POR_MODELO = {
  "E3/E3+": ["REG000000#", "SMS1", "IP/Porta1", "IP/Porta2", "SMS0"],
  "F1/M1": ["IP/Porta", "APN", "Reset"],
  "GTK LW": ["IP/Porta", "APN", "Reset"],
  "GV-50": ["IP/Porta", "APN", "Reset"],
  "GV-55": ["IP/Porta", "APN", "Reset"],
  "GV-75": ["IP/Porta", "APN", "Reset"],
  "ITR-120/155": ["IP/Porta", "APN", "Reset"],
  "J16": ["IP/Porta", "APN", "Reset"],
  "JC181": ["COREKITSW,0", "APN", "URLTYPE,2", "SERVER"],
  "JC400D": ["APN", "SERVER", "RSERVICE", "UPLOAD", "RESET"],
  "JC400AD": ["COREKITSW", "APN", "SERVER", "RSERVICE", "UPLOAD", "FILELIST", "Reset"],
  "JC450": ["URLTYPE,2", "APN", "SERVER", "LOCATEREP", "SHUTDOWNTIME", "WAKEMODE"],
  "VL01/02/03": ["IP/Porta", "APN", "Reset"],
  "LV12": ["IP/Porta", "APN", "Reset"],
  "MXT-140": ["IP/Porta"],
  "N4": ["IP/Porta", "APN", "Reset"],
  "NT20": ["IP/Porta", "APN", "Reset"],
  "Oneblock": ["IP/Porta", "APN", "Reset"],
  "ST3XX": ["IP/Porta", "Rede zip", "Reset"],
  "ST40XX": ["IP/Porta", "APN", "Rede zip", "IG Física", "Reset"],
  "ST80XX": ["IP/Porta", "APN", "Rede zip", "IG Física", "Reset"],
  "TK311": ["IP/Porta", "Reset"],
  "TR05": ["IP/Porta", "APN", "Reset"],
};

function popularSelect(select, opcoes, placeholder) {
  select.innerHTML = "";
  const optVazio = document.createElement("option");
  optVazio.value = "";
  optVazio.textContent = placeholder;
  select.appendChild(optVazio);
  opcoes.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o;
    select.appendChild(opt);
  });
}

popularSelect(comandoModelo, MODELOS_RASTREADOR, "Selecione o modelo...");

comandoModelo.addEventListener("change", () => {
  popularSelect(comandoTipo, COMANDOS_POR_MODELO[comandoModelo.value] || [], "Selecione o comando...");
});

el("form-comando-auth").addEventListener("submit", async (e) => {
  e.preventDefault();
  const usuario = el("comando-usuario").value.trim();
  const senha = el("comando-senha").value;
  if (!usuario || !senha) return;
  try {
    const r = await fetch("/api/comando/autenticar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, senha }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      comandoSaldo.textContent = "Saldo: -";
      comandoSaldo.className = "status-pill status-off";
      return mostrarErro(data.error || "Falha ao autenticar na SMS Market.");
    }
    comandoSaldo.textContent = `Saldo: ${data.saldo}`;
    comandoSaldo.className = "status-pill status-on";
  } catch (err) {
    mostrarErro(String(err));
  }
});

el("btn-comando-gerar").addEventListener("click", async () => {
  const payload = {
    modelo: comandoModelo.value,
    comando: comandoTipo.value,
    id: comandoIdInput.value,
    apn: comandoApnInput.value,
    loginapn: comandoLoginApnInput.value,
    porta: comandoPortaInput.value,
    operadora: comandoOperadora.value,
  };
  try {
    const r = await fetch("/api/comando/gerar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(r);
    comandoPreview.textContent = data.ok ? data.texto : (data.error || "Comando não implementado para este modelo.");
  } catch (err) {
    mostrarErro(String(err));
  }
});

el("btn-comando-limpar").addEventListener("click", () => {
  comandoIdInput.value = "";
  comandoApnInput.value = "";
  comandoLoginApnInput.value = "";
  comandoPortaInput.value = "";
  comandoPreview.textContent = "Escolha o modelo, um comando e clique em Gerar";
});

el("btn-comando-copiar").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(comandoPreview.textContent);
    comandoResposta.textContent = "Comando copiado para a área de transferência.";
  } catch (err) {
    mostrarErro("Não foi possível copiar: " + String(err));
  }
});

async function enviarComandoSms(numero, conteudo, campaignId) {
  try {
    const r = await fetch("/api/comando/enviar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ numero, conteudo, campaign_id: campaignId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErro(data.error || "Falha ao enviar SMS.");
    if (data.saldo !== undefined && data.saldo !== null) {
      comandoSaldo.textContent = `Saldo: ${data.saldo}`;
    }
    comandoResposta.textContent = `Resposta: ${data.resposta}`;
  } catch (err) {
    mostrarErro(String(err));
  }
}

el("btn-comando-enviar-gerado").addEventListener("click", () => {
  const numero = el("comando-numero").value.trim();
  const conteudo = comandoPreview.textContent;
  if (!numero || !conteudo) return mostrarErro("Gere o comando e informe o N° linha.");
  enviarComandoSms(numero, conteudo, "Envio de comando pronto");
});

el("btn-comando-enviar-livre").addEventListener("click", () => {
  const numero = el("comando-numero").value.trim();
  const conteudo = el("comando-texto-livre").value;
  if (!numero || !conteudo) return mostrarErro("Informe o texto e o N° linha.");
  enviarComandoSms(numero, conteudo, "Envio de comando livre");
});

let comandoMassaFileId = null;

el("comando-input-arquivo").addEventListener("change", async () => {
  const file = el("comando-input-arquivo").files[0];
  if (!file) return;
  comandoArquivoNome.textContent = "Enviando...";
  const formData = new FormData();
  formData.append("arquivo", file);
  try {
    const r = await fetch("/api/comando/upload-massa", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      comandoArquivoNome.textContent = "Nenhum arquivo selecionado";
      return mostrarErro(data.error || "Falha ao enviar arquivo.");
    }
    comandoMassaFileId = data.file_id;
    comandoArquivoNome.textContent = `${file.name} (~${data.total_linhas} linhas)`;
    btnComandoEnviarMassa.disabled = false;
  } catch (err) {
    comandoArquivoNome.textContent = "Nenhum arquivo selecionado";
    mostrarErro(String(err));
  }
});

let comandoMassaLogsMostrados = 0;
let comandoMassaPollTimer = null;

function pararPollingMassa() {
  if (comandoMassaPollTimer) {
    clearInterval(comandoMassaPollTimer);
    comandoMassaPollTimer = null;
  }
}

function iniciarPollingMassa(jobId) {
  comandoMassaPollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/comando/enviar-massa/status/${jobId}`);
      const job = await parseJsonResponse(r);
      if (!job.ok) {
        pararPollingMassa();
        return mostrarErro(job.error || "Falha ao consultar andamento.");
      }

      const pct = job.total ? Math.min(Math.round((job.atual / job.total) * 100), 100) : 0;
      comandoMassaBar.style.width = pct + "%";
      comandoMassaPct.textContent = pct + "%";
      comandoMassaStatus.textContent = `Linha ${job.atual} de ${job.total} (sucessos: ${job.sucessos}, erros: ${job.erros})`;

      for (let i = comandoMassaLogsMostrados; i < job.logs.length; i++) {
        const div = document.createElement("div");
        div.className = "log-linha";
        div.textContent = job.logs[i];
        comandoMassaLog.appendChild(div);
      }
      comandoMassaLogsMostrados = job.logs.length;

      if (job.status === "concluido") {
        pararPollingMassa();
        const div = document.createElement("div");
        div.className = "resumo-final";
        div.textContent = `Concluído! Sucessos: ${job.sucessos} | Erros: ${job.erros}`;
        comandoMassaLog.appendChild(div);
        if (job.saldo !== undefined && job.saldo !== null) {
          comandoSaldo.textContent = `Saldo: ${job.saldo}`;
        }
        btnComandoEnviarMassa.disabled = false;
        btnComandoEnviarMassa.textContent = "Enviar";
        comandoMassaFileId = null;
        comandoArquivoNome.textContent = "Nenhum arquivo selecionado";
        el("comando-input-arquivo").value = "";
      }
    } catch (err) {
      pararPollingMassa();
      mostrarErro(String(err));
    }
  }, 1500);
}

btnComandoEnviarMassa.addEventListener("click", async () => {
  if (!comandoMassaFileId) return;
  const intervalo = el("comando-intervalo").value || "5";
  btnComandoEnviarMassa.disabled = true;
  btnComandoEnviarMassa.textContent = "Enviando...";
  comandoMassaProgresso.classList.remove("hidden");
  comandoMassaBar.style.width = "0%";
  comandoMassaPct.textContent = "0%";
  comandoMassaLog.innerHTML = "";
  comandoMassaLogsMostrados = 0;

  try {
    const resp = await fetch("/api/comando/enviar-massa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: comandoMassaFileId, intervalo }),
    });
    const data = await parseJsonResponse(resp);
    if (!data.ok) throw new Error(data.error || "Falha ao iniciar envio em massa.");
    iniciarPollingMassa(data.job_id);
  } catch (err) {
    mostrarErro(String(err));
    btnComandoEnviarMassa.disabled = false;
    btnComandoEnviarMassa.textContent = "Enviar";
  }
});

// --- DELETAR VEÍCULOS EM MASSA ---
const overlayDeletarVeiculos = el("overlay-deletar-veiculos");
const deletarVeiculosInputArquivo = el("deletar-veiculos-input-arquivo");
const deletarVeiculosArquivoNome = el("deletar-veiculos-arquivo-nome");
const btnDeletarVeiculosIniciar = el("btn-deletar-veiculos-iniciar");
const deletarVeiculosProgresso = el("deletar-veiculos-progresso");
const deletarVeiculosBar = el("deletar-veiculos-bar");
const deletarVeiculosStatus = el("deletar-veiculos-status");
const deletarVeiculosPct = el("deletar-veiculos-pct");
const deletarVeiculosLog = el("deletar-veiculos-log");

let deletarVeiculosFileId = null;
let deletarVeiculosTotalLinhas = 0;
// idcentral da Ficha que abriu o modal, se veio de lá — null em uso avulso.
let deletarVeiculosIdcentralAtual = null;

function abrirModalDeletarVeiculos(idcentral) {
  deletarVeiculosIdcentralAtual = idcentral || null;
  deletarVeiculosFileId = null;
  deletarVeiculosTotalLinhas = 0;
  deletarVeiculosInputArquivo.value = "";
  deletarVeiculosArquivoNome.textContent = "Nenhum arquivo selecionado";
  btnDeletarVeiculosIniciar.disabled = true;
  btnDeletarVeiculosIniciar.textContent = "Excluir veículos";
  deletarVeiculosProgresso.classList.add("hidden");
  deletarVeiculosLog.innerHTML = "";
  overlayDeletarVeiculos.classList.remove("hidden");
}

el("deletar-veiculos-fechar").addEventListener("click", () => overlayDeletarVeiculos.classList.add("hidden"));

deletarVeiculosInputArquivo.addEventListener("change", async () => {
  const file = deletarVeiculosInputArquivo.files[0];
  if (!file) return;
  deletarVeiculosArquivoNome.textContent = "Enviando...";
  const formData = new FormData();
  formData.append("arquivo", file);
  try {
    const r = await fetch("/api/deletar-veiculos/upload", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      deletarVeiculosArquivoNome.textContent = "Nenhum arquivo selecionado";
      return alert(`Erro ao enviar arquivo: ${data.error || "falha desconhecida"}`);
    }
    deletarVeiculosFileId = data.file_id;
    deletarVeiculosTotalLinhas = data.total_linhas;
    deletarVeiculosArquivoNome.textContent = `${file.name} (${data.total_linhas} código(s))`;
    btnDeletarVeiculosIniciar.disabled = false;
  } catch (err) {
    deletarVeiculosArquivoNome.textContent = "Nenhum arquivo selecionado";
    alert(`Erro ao enviar arquivo: ${String(err)}`);
  }
});

let deletarVeiculosLogsMostrados = 0;
let deletarVeiculosPollTimer = null;

function pararPollingDeletarVeiculos() {
  if (deletarVeiculosPollTimer) {
    clearInterval(deletarVeiculosPollTimer);
    deletarVeiculosPollTimer = null;
  }
}

function iniciarPollingDeletarVeiculos(jobId) {
  deletarVeiculosPollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/deletar-veiculos/status/${jobId}`);
      const job = await parseJsonResponse(r);
      if (!job.ok) {
        pararPollingDeletarVeiculos();
        return alert(`Erro ao consultar andamento: ${job.error || "falha desconhecida"}`);
      }

      const pct = job.total ? Math.min(Math.round((job.atual / job.total) * 100), 100) : 0;
      deletarVeiculosBar.style.width = pct + "%";
      deletarVeiculosPct.textContent = pct + "%";
      deletarVeiculosStatus.textContent = `Linha ${job.atual} de ${job.total} (sucessos: ${job.sucessos}, erros: ${job.erros})`;

      for (let i = deletarVeiculosLogsMostrados; i < job.logs.length; i++) {
        const div = document.createElement("div");
        div.className = "log-linha";
        div.textContent = job.logs[i];
        deletarVeiculosLog.appendChild(div);
      }
      deletarVeiculosLogsMostrados = job.logs.length;

      if (job.status === "concluido") {
        pararPollingDeletarVeiculos();
        const div = document.createElement("div");
        div.className = "resumo-final";
        div.textContent = `Concluído! Excluídos: ${job.sucessos} | Erros: ${job.erros}`;
        deletarVeiculosLog.appendChild(div);
        btnDeletarVeiculosIniciar.disabled = false;
        btnDeletarVeiculosIniciar.textContent = "Excluir veículos";
        deletarVeiculosFileId = null;
        deletarVeiculosArquivoNome.textContent = "Nenhum arquivo selecionado";
        deletarVeiculosInputArquivo.value = "";
      }
    } catch (err) {
      pararPollingDeletarVeiculos();
      alert(`Erro ao consultar andamento: ${String(err)}`);
    }
  }, 1500);
}

btnDeletarVeiculosIniciar.addEventListener("click", async () => {
  if (!deletarVeiculosFileId) return;
  if (!confirm(`Isso vai excluir permanentemente ${deletarVeiculosTotalLinhas} veículo(s) da SSX. Essa ação NÃO pode ser desfeita. Confirma?`)) return;

  btnDeletarVeiculosIniciar.disabled = true;
  btnDeletarVeiculosIniciar.textContent = "Excluindo...";
  deletarVeiculosProgresso.classList.remove("hidden");
  deletarVeiculosBar.style.width = "0%";
  deletarVeiculosPct.textContent = "0%";
  deletarVeiculosLog.innerHTML = "";
  deletarVeiculosLogsMostrados = 0;

  try {
    const resp = await fetch("/api/deletar-veiculos/executar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: deletarVeiculosFileId, idcentral: deletarVeiculosIdcentralAtual }),
    });
    const data = await parseJsonResponse(resp);
    if (!data.ok) throw new Error(data.error || "Falha ao iniciar exclusão em massa.");
    iniciarPollingDeletarVeiculos(data.job_id);
  } catch (err) {
    alert(`Erro: ${String(err)}`);
    btnDeletarVeiculosIniciar.disabled = false;
    btnDeletarVeiculosIniciar.textContent = "Excluir veículos";
  }
});

// --- ASSOCIAR RASTREADORES EM MASSA ---
const overlayAssociarRastreadores = el("overlay-associar-rastreadores");
const associarRastreadoresInputArquivo = el("associar-rastreadores-input-arquivo");
const associarRastreadoresArquivoNome = el("associar-rastreadores-arquivo-nome");
const btnAssociarRastreadoresIniciar = el("btn-associar-rastreadores-iniciar");
const associarRastreadoresProgresso = el("associar-rastreadores-progresso");
const associarRastreadoresBar = el("associar-rastreadores-bar");
const associarRastreadoresStatus = el("associar-rastreadores-status");
const associarRastreadoresPct = el("associar-rastreadores-pct");
const associarRastreadoresLog = el("associar-rastreadores-log");

let associarRastreadoresFileId = null;
let associarRastreadoresTotalLinhas = 0;
// idcentral da Ficha que abriu o modal, se veio de lá — null em uso avulso.
let associarRastreadoresIdcentralAtual = null;

function abrirModalAssociarRastreadores(idcentral) {
  associarRastreadoresIdcentralAtual = idcentral || null;
  associarRastreadoresFileId = null;
  associarRastreadoresTotalLinhas = 0;
  associarRastreadoresInputArquivo.value = "";
  associarRastreadoresArquivoNome.textContent = "Nenhum arquivo selecionado";
  btnAssociarRastreadoresIniciar.disabled = true;
  btnAssociarRastreadoresIniciar.textContent = "Associar rastreadores";
  associarRastreadoresProgresso.classList.add("hidden");
  associarRastreadoresLog.innerHTML = "";
  overlayAssociarRastreadores.classList.remove("hidden");
}

el("associar-rastreadores-fechar").addEventListener("click", () => overlayAssociarRastreadores.classList.add("hidden"));

associarRastreadoresInputArquivo.addEventListener("change", async () => {
  const file = associarRastreadoresInputArquivo.files[0];
  if (!file) return;
  associarRastreadoresArquivoNome.textContent = "Enviando...";
  const formData = new FormData();
  formData.append("arquivo", file);
  try {
    const r = await fetch("/api/associar-rastreadores/upload", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      associarRastreadoresArquivoNome.textContent = "Nenhum arquivo selecionado";
      return alert(`Erro ao enviar arquivo: ${data.error || "falha desconhecida"}`);
    }
    associarRastreadoresFileId = data.file_id;
    associarRastreadoresTotalLinhas = data.total_linhas;
    associarRastreadoresArquivoNome.textContent = `${file.name} (${data.total_linhas} par(es))`;
    btnAssociarRastreadoresIniciar.disabled = false;
  } catch (err) {
    associarRastreadoresArquivoNome.textContent = "Nenhum arquivo selecionado";
    alert(`Erro ao enviar arquivo: ${String(err)}`);
  }
});

let associarRastreadoresLogsMostrados = 0;
let associarRastreadoresPollTimer = null;

function pararPollingAssociarRastreadores() {
  if (associarRastreadoresPollTimer) {
    clearInterval(associarRastreadoresPollTimer);
    associarRastreadoresPollTimer = null;
  }
}

function iniciarPollingAssociarRastreadores(jobId) {
  associarRastreadoresPollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/associar-rastreadores/status/${jobId}`);
      const job = await parseJsonResponse(r);
      if (!job.ok) {
        pararPollingAssociarRastreadores();
        return alert(`Erro ao consultar andamento: ${job.error || "falha desconhecida"}`);
      }

      const pct = job.total ? Math.min(Math.round((job.atual / job.total) * 100), 100) : 0;
      associarRastreadoresBar.style.width = pct + "%";
      associarRastreadoresPct.textContent = pct + "%";
      associarRastreadoresStatus.textContent = `Linha ${job.atual} de ${job.total} (sucessos: ${job.sucessos}, erros: ${job.erros})`;

      for (let i = associarRastreadoresLogsMostrados; i < job.logs.length; i++) {
        const div = document.createElement("div");
        div.className = "log-linha";
        div.textContent = job.logs[i];
        associarRastreadoresLog.appendChild(div);
      }
      associarRastreadoresLogsMostrados = job.logs.length;

      if (job.status === "concluido") {
        pararPollingAssociarRastreadores();
        const div = document.createElement("div");
        div.className = "resumo-final";
        div.textContent = `Concluído! Associados: ${job.sucessos} | Erros: ${job.erros}`;
        associarRastreadoresLog.appendChild(div);
        btnAssociarRastreadoresIniciar.disabled = false;
        btnAssociarRastreadoresIniciar.textContent = "Associar rastreadores";
        associarRastreadoresFileId = null;
        associarRastreadoresArquivoNome.textContent = "Nenhum arquivo selecionado";
        associarRastreadoresInputArquivo.value = "";
      }
    } catch (err) {
      pararPollingAssociarRastreadores();
      alert(`Erro ao consultar andamento: ${String(err)}`);
    }
  }, 1500);
}

btnAssociarRastreadoresIniciar.addEventListener("click", async () => {
  if (!associarRastreadoresFileId) return;
  if (!confirm(`Isso vai associar ${associarRastreadoresTotalLinhas} par(es) de veículo/rastreador na SSX. Confirma?`)) return;

  btnAssociarRastreadoresIniciar.disabled = true;
  btnAssociarRastreadoresIniciar.textContent = "Associando...";
  associarRastreadoresProgresso.classList.remove("hidden");
  associarRastreadoresBar.style.width = "0%";
  associarRastreadoresPct.textContent = "0%";
  associarRastreadoresLog.innerHTML = "";
  associarRastreadoresLogsMostrados = 0;

  try {
    const resp = await fetch("/api/associar-rastreadores/executar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: associarRastreadoresFileId, idcentral: associarRastreadoresIdcentralAtual }),
    });
    const data = await parseJsonResponse(resp);
    if (!data.ok) throw new Error(data.error || "Falha ao iniciar associação em massa.");
    iniciarPollingAssociarRastreadores(data.job_id);
  } catch (err) {
    alert(`Erro: ${String(err)}`);
    btnAssociarRastreadoresIniciar.disabled = false;
    btnAssociarRastreadoresIniciar.textContent = "Associar rastreadores";
  }
});

// --- CONVERSOR KML -> SSX (Áreas/Rotas) ---
// Sub-tela "/ferramentas/conversor-kml". Mesma engine e mesmo fluxo do conversor da Universidade
// Systemsat (src/app/components/conversor-kml-ssx): roda 100% no navegador — parse, validação,
// edição manual e geração do KML/CSV, sem enviar o arquivo pro servidor. conversorkml.py segue as
// mesmas regras (uso por linha de comando).
const conversorInputArquivo = el("conversor-input-arquivo");
const conversorArquivoNome = el("conversor-arquivo-nome");
const conversorCategoria = el("conversor-categoria");
const conversorGrupo = el("conversor-grupo");
const conversorTolerancia = el("conversor-tolerancia");
const conversorForcarAreas = el("conversor-forcar-areas");
const btnConversorConverter = el("btn-conversor-converter");
const conversorResultado = el("conversor-resultado");
const conversorCores = el("conversor-cores");

// Limites do manual de importação SSX.
const KML_MAX_NAME = 150;
const KML_MAX_DESCRIPTION = 500;
const KML_MAX_GEO_CODE = 40;
const KML_MAX_CATEGORY_CODE = 8000;
const KML_MAX_GROUP_CODE = 40;
const KML_MAX_COORDINATES = 8000;
const KML_MAX_LINHAS_IMPORTACAO = 3000; // manual SSX v1.4, 13/11/2025
const KML_TAMANHO_PARTE = 1000; // abaixo do limite de importação, pra manter os arquivos leves
const KML_LIMITE_PROBLEMATICOS = 500;
const KML_NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

// Avisos que aparecem em quase todo registro (ex.: forçar áreas): viram só uma contagem.
const KML_AVISOS_COMPACTAVEIS = ["GeoIntegrationCode truncado", "polígono fechado automaticamente", "Coordenadas excedem"];

const KML_TIPO_LABEL = { Polygon: "Área", LineString: "Rota", Point: "Ponto" };
const KML_TIPO_OPCOES = [
  { value: "Point", label: "Ponto" },
  { value: "LineString", label: "Rota" },
  { value: "Polygon", label: "Área" },
];

// Tabela de cores do manual de importação SSX (pág. 8).
const CORES_SSX = [
  { codigo: 1, hex: "#988383" },
  { codigo: 2, hex: "#D65E5E" },
  { codigo: 3, hex: "#D97B4C" },
  { codigo: 4, hex: "#D66B98" },
  { codigo: 5, hex: "#936BD6" },
  { codigo: 6, hex: "#608CE0" },
  { codigo: 7, hex: "#65D6B7" },
  { codigo: 8, hex: "#9FD96D" },
  { codigo: 9, hex: "#F0B132" },
  { codigo: 10, hex: "#949191" },
  { codigo: 11, hex: "#C2C0C0" },
  { codigo: 12, hex: "#555555" },
  { codigo: 13, hex: "#F6F6F6" },
];
const KML_CORES_VALIDAS = new Set(CORES_SSX.map((c) => String(c.codigo)));

function kmlSemAcento(texto) {
  return (texto || "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function kmlSlug(texto, maxLen = 20) {
  const limpo = kmlSemAcento(texto).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return limpo.slice(0, maxLen) || "SEM_NOME";
}

function kmlEscapeXml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function kmlTexto(elem) {
  return elem ? (elem.textContent || "").trim() : "";
}

// Google Earth/My Maps salvam a <description> como HTML ("<div>texto<br></div>"); dentro de CDATA
// o parser trata como texto, então as tags iriam literalmente pro SSX sem essa limpeza.
function kmlLimparDescricaoHtml(bruta) {
  const texto = (bruta || "").trim();
  if (!texto || !/<[a-z][\s\S]*>/i.test(texto)) return texto;
  const comQuebras = texto.replace(/<\s*br\s*\/?\s*>/gi, "\n").replace(/<\/\s*(p|div|li|tr)\s*>/gi, "\n");
  const doc = new DOMParser().parseFromString(comQuebras, "text/html");
  return (doc.body.textContent || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

function kmlFilho(elem, nome) {
  return Array.from(elem.children).find((c) => c.localName === nome) || null;
}

function kmlDescendente(elem, nome) {
  for (const child of Array.from(elem.children)) {
    if (child.localName === nome) return child;
    const achado = kmlDescendente(child, nome);
    if (achado) return achado;
  }
  return null;
}

// Bloco {{Nome|Cat|Grupo|Tolerância|CódÁrea|Cor}} na descrição (padrão do manual).
function kmlExtrairBlocoDescricao(descricao) {
  const m = /\{\{([\s\S]*?)\}\}/.exec(descricao || "");
  if (!m) return [{}, (descricao || "").trim()];
  const partes = m[1].split("|").map((p) => p.trim());
  const campos = ["Name", "CategoryIntegrationCode", "GroupIntegrationCode", "Tolerance", "GeoIntegrationCode", "ColorCode"];
  const dados = {};
  campos.forEach((campo, i) => {
    if (partes[i]) dados[campo] = partes[i];
  });
  return [dados, (descricao || "").replace(/\{\{[\s\S]*?\}\}/g, "").replace(/ +/g, " ").trim()];
}

function kmlExtrairExtendedData(placemark) {
  const dados = {};
  const ext = kmlFilho(placemark, "ExtendedData");
  if (!ext) return dados;
  Array.from(ext.children)
    .filter((c) => c.localName === "Data")
    .forEach((data) => {
      const nome = (data.getAttribute("name") || "").trim();
      if (nome) dados[nome] = kmlTexto(kmlFilho(data, "value"));
    });
  return dados;
}

function kmlExtrairGeometria(placemark) {
  for (const tipo of ["Polygon", "LineString", "Point"]) {
    const geom = kmlDescendente(placemark, tipo);
    if (geom) return [tipo, kmlTexto(kmlDescendente(geom, "coordinates"))];
  }
  return [null, ""];
}

function kmlNormalizarCoordenadas(coordsTexto) {
  return coordsTexto
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const partes = token.split(",");
      if (partes.length < 2) throw new Error(`Coordenada inválida: '${token}'`);
      const lon = partes[0].trim();
      const lat = partes[1].trim();
      if (!KML_NUM_RE.test(lon) || !KML_NUM_RE.test(lat)) throw new Error(`Coordenada não numérica: '${token}'`);
      const lonF = parseFloat(lon);
      const latF = parseFloat(lat);
      if (lonF < -180 || lonF > 180 || latF < -90 || latF > 90) {
        throw new Error(`Coordenada fora do intervalo esperado (lon lat): '${token}'`);
      }
      return `${lon},${lat},0`;
    });
}

// GeoIntegrationCode gerado: Grupo_Nome_número (o número garante unicidade).
function kmlGerarGeoCode(grupo, nome, indice) {
  const idx = String(indice).padStart(3, "0");
  return `${(grupo || "").trim()}_${kmlSlug(nome)}_${idx}`.replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, KML_MAX_GEO_CODE);
}

function kmlMontarPlacemark(placemark, config, indice) {
  const erros = [];
  const avisos = [];

  let nome = kmlTexto(kmlFilho(placemark, "name"));
  const descricaoBruta = kmlLimparDescricaoHtml(kmlTexto(kmlFilho(placemark, "description")));

  // A tag do KML só serve pra achar as coordenadas: o tipo (Ponto/Rota/Área) vem das próprias
  // coordenadas, porque clientes exportam áreas como LineString quando o anel não fica fechado.
  const [geometria, coordsTexto] = kmlExtrairGeometria(placemark);
  if (geometria === null) erros.push("Placemark sem geometria (Polygon, LineString ou Point)");

  let pontos = [];
  let coordenadasInvalidas = false;
  if (geometria !== null) {
    try {
      pontos = kmlNormalizarCoordenadas(coordsTexto);
    } catch (e) {
      erros.push(e.message);
      coordenadasInvalidas = true;
    }
  }

  // Ponto: 1 coordenada. Área: 2+ com anel fechado (1ª = última). Rota: 2+ sem fechamento.
  let tipoOriginal = null;
  if (pontos.length === 1) tipoOriginal = "Point";
  else if (pontos.length >= 2) tipoOriginal = pontos[0] === pontos[pontos.length - 1] ? "Polygon" : "LineString";
  else if (geometria !== null && !coordenadasInvalidas) erros.push("Nenhuma coordenada encontrada na geometria");

  const dados = kmlExtrairExtendedData(placemark);
  const [bloco, descricaoBase] = kmlExtrairBlocoDescricao(descricaoBruta);
  let descricao = descricaoBase;
  Object.assign(dados, bloco);
  if (bloco.Name) nome = bloco.Name;

  if (!dados.CategoryIntegrationCode) {
    if (config.categoria) dados.CategoryIntegrationCode = config.categoria;
    else erros.push("Campo obrigatório 'CategoryIntegrationCode' não informado (defina um valor padrão)");
  }
  if (!dados.GroupIntegrationCode) {
    if (config.grupo) dados.GroupIntegrationCode = config.grupo;
    else erros.push("Campo obrigatório 'GroupIntegrationCode' não informado (defina um valor padrão)");
  }

  // GeoIntegrationCode informado no KML (ExtendedData ou {{...}}) é mantido; só gera quando falta.
  const codigoInformado = (dados.GeoIntegrationCode || "").trim();
  if (codigoInformado) {
    if (codigoInformado.length > KML_MAX_GEO_CODE) erros.push(`'GeoIntegrationCode' excede ${KML_MAX_GEO_CODE} caracteres`);
    dados.GeoIntegrationCode = codigoInformado;
  } else {
    const codigoGerado = kmlGerarGeoCode(dados.GroupIntegrationCode, nome, indice);
    if (`${dados.GroupIntegrationCode || ""}_${kmlSlug(nome)}_${String(indice).padStart(3, "0")}`.length > KML_MAX_GEO_CODE) {
      avisos.push(`GeoIntegrationCode truncado para ${KML_MAX_GEO_CODE} caracteres: ${codigoGerado}`);
    }
    dados.GeoIntegrationCode = codigoGerado;
  }

  // Sem Name no Placemark: usa o código de integração como nome.
  if (!nome) nome = dados.GeoIntegrationCode;

  let tipoFinal = tipoOriginal;
  let convertido = false;
  if (config.forcarAreas && tipoOriginal === "LineString") {
    tipoFinal = "Polygon";
    convertido = true;
    if (pontos.length > 0 && pontos[0] !== pontos[pontos.length - 1]) {
      pontos.push(pontos[0]);
      avisos.push("Rota convertida em área: polígono fechado automaticamente (ponto inicial repetido no final)");
    }
  }

  if (tipoFinal === "Point" && !dados.Tolerance) {
    if (config.tolerancia !== undefined && config.tolerancia !== null) dados.Tolerance = String(config.tolerancia);
    else erros.push("Tolerance é obrigatório para o tipo Ponto (defina uma tolerância padrão)");
  }

  if (!dados.ColorCode && config.cor) dados.ColorCode = String(config.cor);

  if (nome.length > KML_MAX_NAME) erros.push(`'Name' excede ${KML_MAX_NAME} caracteres (${nome.length})`);
  if (descricao.length > KML_MAX_DESCRIPTION) {
    avisos.push(`Descrição excedia ${KML_MAX_DESCRIPTION} caracteres (provável HTML bruto); substituída pelo nome da área`);
    descricao = nome;
  }
  if ((dados.CategoryIntegrationCode || "").length > KML_MAX_CATEGORY_CODE) {
    erros.push(`'CategoryIntegrationCode' excede ${KML_MAX_CATEGORY_CODE} caracteres`);
  }
  if ((dados.GroupIntegrationCode || "").length > KML_MAX_GROUP_CODE) {
    erros.push(`'GroupIntegrationCode' excede ${KML_MAX_GROUP_CODE} caracteres`);
  }
  if (dados.Tolerance && !/^-?\d+$/.test(dados.Tolerance.trim())) {
    erros.push(`'Tolerance' deve ser um número inteiro (metros): '${dados.Tolerance}'`);
  }
  if (dados.ColorCode) {
    let col = dados.ColorCode.trim();
    if (/^\d+$/.test(col)) col = String(parseInt(col, 10));
    dados.ColorCode = col;
    if (!KML_CORES_VALIDAS.has(col)) {
      avisos.push(`ColorCode '${dados.ColorCode}' fora da tabela (1 a 13); campo removido`);
      delete dados.ColorCode;
    }
  }

  if (tipoFinal === "Polygon" && pontos.length > 0) {
    const distintos = new Set(pontos).size;
    if (distintos < 3) erros.push(`Área deve ter no mínimo 3 pontos (encontrados ${distintos})`);
  }

  const coordsFinal = pontos.join("\n          ");
  if (coordsFinal.length > KML_MAX_COORDINATES) {
    avisos.push(`Coordenadas excedem ${KML_MAX_COORDINATES} caracteres (${coordsFinal.length}); o sistema pode rejeitar este registro`);
  }

  return { indice, nome, descricao, tipoOriginal, tipoFinal, convertido, pontos, dados, avisos, erros };
}

// KMZ é só um .kml compactado em .zip (geralmente como "doc.kml") junto com ícones/imagens.
// Lê o índice central do ZIP (sem lib externa) pra achar e descomprimir esse .kml.
async function kmlExtrairTextoDeKmz(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  // Localiza o End Of Central Directory varrendo de trás pra frente: o .zip pode
  // ter um comentário final de tamanho variável (até 65535 bytes) antes do fim do arquivo.
  let eocdOffset = -1;
  const limiteBusca = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= limiteBusca; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error("Arquivo .kmz inválido: não foi possível localizar o índice do pacote ZIP.");
  }

  const totalEntradas = view.getUint16(eocdOffset + 10, true);
  let cdOffset = view.getUint32(eocdOffset + 16, true);

  const entradasKml = [];
  for (let i = 0; i < totalEntradas; i++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) {
      throw new Error("Arquivo .kmz inválido: índice do pacote ZIP corrompido.");
    }
    const metodoCompressao = view.getUint16(cdOffset + 10, true);
    const tamanhoComprimido = view.getUint32(cdOffset + 20, true);
    const tamanhoNome = view.getUint16(cdOffset + 28, true);
    const tamanhoExtra = view.getUint16(cdOffset + 30, true);
    const tamanhoComentario = view.getUint16(cdOffset + 32, true);
    const offsetLocal = view.getUint32(cdOffset + 42, true);
    const nome = new TextDecoder("utf-8").decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + tamanhoNome));

    if (nome.toLowerCase().endsWith(".kml")) {
      entradasKml.push({ nome, metodoCompressao, tamanhoComprimido, offsetLocal });
    }
    cdOffset += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }

  if (entradasKml.length === 0) {
    throw new Error("O arquivo .kmz não contém nenhum .kml dentro do pacote.");
  }
  // Prioriza "doc.kml" (padrão do Google Earth/My Maps); senão usa o primeiro .kml encontrado.
  const entrada = entradasKml.find((e) => e.nome.toLowerCase().split("/").pop() === "doc.kml") || entradasKml[0];

  // O cabeçalho local pode ter nome/campo extra de tamanho diferente do índice central,
  // então é preciso reler esses tamanhos ali pra saber onde os dados comprimidos começam.
  const tamanhoNomeLocal = view.getUint16(entrada.offsetLocal + 26, true);
  const tamanhoExtraLocal = view.getUint16(entrada.offsetLocal + 28, true);
  const inicioDados = entrada.offsetLocal + 30 + tamanhoNomeLocal + tamanhoExtraLocal;
  const dadosComprimidos = bytes.subarray(inicioDados, inicioDados + entrada.tamanhoComprimido);

  let dadosFinais;
  if (entrada.metodoCompressao === 0) {
    dadosFinais = dadosComprimidos;
  } else if (entrada.metodoCompressao === 8) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("Este navegador não sabe descompactar arquivos .kmz. Extraia o .kml de dentro do .kmz e envie-o diretamente.");
    }
    const stream = new Blob([dadosComprimidos]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    dadosFinais = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw new Error(`O .kml dentro do .kmz usa um método de compressão não suportado (código ${entrada.metodoCompressao}).`);
  }

  return new TextDecoder("utf-8").decode(dadosFinais);
}

async function kmlLerArquivoConversor(file) {
  if (!/\.kmz$/i.test(file.name)) {
    return file.text();
  }
  const buffer = await file.arrayBuffer();
  return kmlExtrairTextoDeKmz(buffer);
}

function kmlProcessar(kmlText, config) {
  const doc = new DOMParser().parseFromString(kmlText, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error(
      "O arquivo de entrada não é um XML/KML válido. Dica: verifique se caracteres especiais na " +
        "<description> estão dentro de <![CDATA[ ]]> (ver manual, pág. 8)."
    );
  }
  const placemarks = Array.from(doc.getElementsByTagNameNS("*", "Placemark"));
  if (placemarks.length === 0) throw new Error("Nenhum <Placemark> encontrado no arquivo.");
  return placemarks.map((pm, i) => kmlMontarPlacemark(pm, config, i + 1));
}

function kmlMontarXmlPlacemark(registro) {
  const { dados, nome, descricao, tipoFinal, pontos } = registro;
  const coordsFinal = pontos.join("\n          ");
  const linhasExt = ["GeoIntegrationCode", "CategoryIntegrationCode", "GroupIntegrationCode", "Tolerance", "ColorCode"]
    .filter((campo) => dados[campo])
    .map((campo) => `      <Data name="${campo}">\n        <value>${kmlEscapeXml(dados[campo])}</value>\n      </Data>`);
  const extXml = `    <ExtendedData>\n${linhasExt.join("\n")}\n    </ExtendedData>`;
  const descXml = descricao ? `    <description><![CDATA[${descricao}]]></description>\n` : "";

  // Polygon precisa do wrapper OGC (outerBoundaryIs/LinearRing): sem ele o SSX aceita o arquivo
  // mas diz "Não tem registros nesse arquivo" (confirmado em teste real, 2026-09-29).
  let geomXml;
  if (tipoFinal === "Polygon") {
    geomXml =
      `    <Polygon>\n      <outerBoundaryIs>\n        <LinearRing>\n          <coordinates>\n` +
      `          ${coordsFinal}\n          </coordinates>\n        </LinearRing>\n      </outerBoundaryIs>\n    </Polygon>`;
  } else if (tipoFinal === "LineString") {
    geomXml = `    <LineString>\n      <coordinates>\n          ${coordsFinal}\n      </coordinates>\n    </LineString>`;
  } else {
    geomXml = `    <Point>\n      <coordinates>\n          ${coordsFinal}\n      </coordinates>\n    </Point>`;
  }
  return `  <Placemark>\n    <name>${kmlEscapeXml(nome)}</name>\n${descXml}${extXml}\n${geomXml}\n  </Placemark>`;
}

// Gera a partir exatamente dos registros recebidos (quem chama decide se já
// filtrou os com erro ou não — ver baixarConversao, que oferece as duas opções).
function kmlGerarKml(registros) {
  const blocos = registros.map(kmlMontarXmlPlacemark);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n' +
    blocos.join("\n") +
    "\n</Document>\n</kml>\n"
  );
}

const KML_TIPO_CSV = { Polygon: "1", LineString: "2", Point: "3" };
const KML_CSV_CABECALHO = "Nome;Descricao;Tipo;Coordenadas;Tolerancia;Cod.integracao;Cod.categoria;Cod.grupo;Cod.cor;";

// CSV do manual (pág. 2): sem acentos, ';' como separador, \r\n, coordenadas "lon lat" separadas por ','.
function kmlGerarCsv(registros) {
  const linhas = [KML_CSV_CABECALHO];
  registros.forEach((r) => {
    const coords = r.pontos
      .map((p) => {
        const [lon, lat] = p.split(",");
        return `${lon} ${lat}`;
      })
      .join(",");
    const campos = [
      r.nome,
      r.descricao,
      KML_TIPO_CSV[r.tipoFinal || ""] || "",
      coords,
      r.dados.Tolerance || "",
      r.dados.GeoIntegrationCode || "",
      r.dados.CategoryIntegrationCode || "",
      r.dados.GroupIntegrationCode || "",
      r.dados.ColorCode || "",
    ];
    linhas.push(campos.map((c) => kmlSemAcento(c).replace(/\r/g, " ").replace(/\n/g, " ").replace(/;/g, ",")).join(";") + ";");
  });
  return linhas.join("\r\n") + "\r\n";
}

function kmlBaixarArquivo(nomeArquivo, conteudo, mimetype) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: mimetype }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Resumo mostrado na tela: contagens, partes de até 1000 registros e lista de problemáticos.
function kmlMontarResultado(registros) {
  const nErro = registros.filter((r) => r.erros.length > 0).length;
  const nOk = registros.length - nErro;
  // Baseado no total (não só nos válidos): registros com erro também precisam de uma
  // "parte" pra morar, já que agora é possível baixá-los (ver baixarConversao).
  const nPartes = registros.length > KML_TAMANHO_PARTE ? Math.ceil(registros.length / KML_TAMANHO_PARTE) : 1;
  const avisosCompactados = { geoTruncado: 0, anelFechado: 0, coordenadasLongas: 0 };
  const problematicos = [];

  registros.forEach((r) => {
    if (r.erros.length === 0 && r.avisos.length === 0) return;
    const soCompactaveis =
      r.erros.length === 0 && r.avisos.every((av) => KML_AVISOS_COMPACTAVEIS.some((chave) => av.includes(chave)));
    if (soCompactaveis) {
      r.avisos.forEach((av) => {
        if (av.includes("GeoIntegrationCode truncado")) avisosCompactados.geoTruncado++;
        else if (av.includes("polígono fechado automaticamente")) avisosCompactados.anelFechado++;
        else if (av.includes("Coordenadas excedem")) avisosCompactados.coordenadasLongas++;
      });
      return;
    }
    problematicos.push(r);
  });

  return {
    registros,
    nOk,
    nErro,
    nPartes,
    avisosCompactados,
    problematicos: problematicos.slice(0, KML_LIMITE_PROBLEMATICOS),
    problematicosOcultos: Math.max(0, problematicos.length - KML_LIMITE_PROBLEMATICOS),
  };
}

// --- Estado da tela ---
let conversorNomeBase = "conversao";
let conversorRegistrosOriginais = null;
let conversorResultadoAtual = null;

function renderConversorCores() {
  conversorCores.innerHTML = "";

  const btnNenhuma = document.createElement("button");
  btnNenhuma.type = "button";
  btnNenhuma.className = "conversor-cor-swatch-nenhuma";
  btnNenhuma.textContent = "Padrão (1)";
  btnNenhuma.title = "Não escolher cor: o SSX grava com a cor padrão (código 1)";
  if (estado.conversorCor === null) btnNenhuma.classList.add("selecionada");
  btnNenhuma.addEventListener("click", () => {
    estado.conversorCor = null;
    renderConversorCores();
  });
  conversorCores.appendChild(btnNenhuma);

  CORES_SSX.forEach(({ codigo, hex }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "conversor-cor-swatch";
    btn.style.background = hex;
    btn.title = `Código ${codigo} (${hex})`;
    btn.textContent = String(codigo);
    if (estado.conversorCor === codigo) btn.classList.add("selecionada");
    btn.addEventListener("click", () => {
      estado.conversorCor = codigo;
      renderConversorCores();
    });
    conversorCores.appendChild(btn);
  });
}

function limparConversor() {
  estado.conversorArquivo = null;
  estado.conversorCor = null;
  conversorNomeBase = "conversao";
  conversorRegistrosOriginais = null;
  conversorResultadoAtual = null;
  conversorInputArquivo.value = "";
  conversorArquivoNome.textContent = "Nenhum arquivo selecionado";
  conversorCategoria.value = "";
  conversorGrupo.value = "";
  conversorTolerancia.value = "";
  conversorForcarAreas.checked = false;
  conversorResultado.innerHTML = "";
  renderConversorCores();
  btnConversorConverter.disabled = true;
  btnConversorConverter.textContent = "Converter arquivo";
}

// Estado inicial (inclusive quando a página abre direto em /ferramentas/conversor-kml).
limparConversor();

conversorInputArquivo.addEventListener("change", () => {
  const file = conversorInputArquivo.files[0];
  estado.conversorArquivo = file || null;
  conversorArquivoNome.textContent = file ? file.name : "Nenhum arquivo selecionado";
  conversorNomeBase = file ? file.name.replace(/\.(kml|kmz)$/i, "") : "conversao";
  conversorRegistrosOriginais = null;
  conversorResultadoAtual = null;
  conversorResultado.innerHTML = "";
  btnConversorConverter.disabled = !file;
});

function mostrarErroConversor(msg) {
  conversorResultado.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  conversorResultado.appendChild(p);
}

function kmlMensagens(r) {
  return [...r.erros.map((m) => `⛔ ${m}`), ...r.avisos.map((m) => `⚠️ ${m}`)].join("\n");
}

function baixarConversaoComoArquivo(fatia, formato, parte) {
  const sufixoParte = conversorResultadoAtual.nPartes > 1 ? `_parte${parte}` : "";
  if (formato === "kml") {
    kmlBaixarArquivo(`${conversorNomeBase}_SSX${sufixoParte}.kml`, kmlGerarKml(fatia), "application/vnd.google-earth.kml+xml");
  } else {
    kmlBaixarArquivo(`${conversorNomeBase}_SSX${sufixoParte}.csv`, kmlGerarCsv(fatia), "text/csv");
  }
}

// Confirmação antes de baixar quando a parte selecionada tem registro(s) com erro —
// modal próprio em vez de confirm() nativo, pra não quebrar a identidade visual do app
// (mesmo padrão de confirmarVincularMigracao/confirmarLiberarPlanilha).
const overlayConversorBaixarErro = el("overlay-conversor-baixar-erro");
const textoConversorBaixarErro = el("conversor-baixar-erro-texto");
let resolverConversorBaixarErro = null;
function fecharConversorBaixarErro(escolha) {
  overlayConversorBaixarErro.classList.add("hidden");
  const resolve = resolverConversorBaixarErro;
  resolverConversorBaixarErro = null;
  if (resolve) resolve(escolha);
}
function confirmarConversorBaixarErro(nComErro) {
  const plural = nComErro === 1 ? "registro não passou" : "registros não passaram";
  textoConversorBaixarErro.textContent =
    `${nComErro} ${plural} na validação e podem ser rejeitados pelo SSX na importação. Baixe só os válidos, ou inclua os com erro pra corrigir depois.`;
  overlayConversorBaixarErro.classList.remove("hidden");
  return new Promise((resolve) => { resolverConversorBaixarErro = resolve; });
}
el("conversor-baixar-erro-fechar").addEventListener("click", () => fecharConversorBaixarErro("cancelar"));
el("btn-conversor-baixar-erro-cancelar").addEventListener("click", () => fecharConversorBaixarErro("cancelar"));
el("btn-conversor-baixar-com-erros").addEventListener("click", () => fecharConversorBaixarErro("com-erros"));
el("btn-conversor-baixar-sem-erros").addEventListener("click", () => fecharConversorBaixarErro("sem-erros"));

async function baixarConversao(parte, formato) {
  if (!conversorResultadoAtual) return;
  const fatiaCompleta = conversorResultadoAtual.registros.slice((parte - 1) * KML_TAMANHO_PARTE, parte * KML_TAMANHO_PARTE);
  if (fatiaCompleta.length === 0) return;
  const nComErro = fatiaCompleta.filter((r) => r.erros.length > 0).length;

  let fatiaFinal = fatiaCompleta;
  if (nComErro > 0) {
    const escolha = await confirmarConversorBaixarErro(nComErro);
    if (escolha === "cancelar") return;
    if (escolha === "sem-erros") {
      fatiaFinal = fatiaCompleta.filter((r) => r.erros.length === 0);
      if (fatiaFinal.length === 0) return; // essa parte era só registro(s) com erro
    }
  }
  baixarConversaoComoArquivo(fatiaFinal, formato, parte);
}

function renderConversorResultado() {
  const r = conversorResultadoAtual;
  conversorResultado.innerHTML = "";
  if (!r) return;

  const tiles = document.createElement("div");
  tiles.className = "dashboard-tiles";
  [
    { valor: r.nOk, label: "Válidos" },
    { valor: r.nErro, label: "Com erro" },
  ].forEach(({ valor, label }) => {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const l = document.createElement("div");
    l.className = "stat-tile-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "stat-tile-valor";
    v.textContent = valor;
    tile.appendChild(l);
    tile.appendChild(v);
    tiles.appendChild(tile);
  });
  conversorResultado.appendChild(tiles);

  const legenda = document.createElement("p");
  legenda.className = "placeholder";
  legenda.textContent = `${r.nOk} de ${r.registros.length} registro(s) válidos para importar.`;
  conversorResultado.appendChild(legenda);

  if (r.nPartes > 1) {
    const aviso = document.createElement("p");
    aviso.className = "placeholder";
    aviso.style.color = "#a16207";
    aviso.textContent = `O SSX importa no máximo ${KML_MAX_LINHAS_IMPORTACAO} linhas por arquivo. Os ${r.registros.length} registro(s) foram divididos em ${r.nPartes} arquivo(s) de até ${KML_TAMANHO_PARTE} cada — importe um de cada vez.`;
    conversorResultado.appendChild(aviso);
  }

  const edicao = document.createElement("div");
  edicao.className = "conversor-edicao-toggle";
  const btnEditar = document.createElement("button");
  btnEditar.type = "button";
  btnEditar.className = "conversor-btn-editar";
  btnEditar.textContent = "✎ Edição manual";
  btnEditar.addEventListener("click", abrirEdicaoConversor);
  edicao.appendChild(btnEditar);
  conversorResultado.appendChild(edicao);

  // Botão aparece mesmo com nOk === 0 (todos com erro): ao clicar, baixarConversao()
  // mostra o pop-up perguntando se quer baixar com ou sem os registros com erro.
  const downloads = document.createElement("div");
  downloads.className = "conversor-downloads";
  for (let parte = 1; parte <= r.nPartes; parte++) {
    const sufixoParte = r.nPartes > 1 ? ` (parte ${parte}/${r.nPartes})` : "";
    ["kml", "csv"].forEach((formato) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-secondary";
      btn.textContent = `Baixar ${formato.toUpperCase()}${sufixoParte}`;
      btn.addEventListener("click", () => baixarConversao(parte, formato));
      downloads.appendChild(btn);
    });
  }
  conversorResultado.appendChild(downloads);

  const ac = r.avisosCompactados;
  const compactados = [
    ac.anelFechado ? `${ac.anelFechado} ${ac.anelFechado === 1 ? "polígono fechado" : "polígonos fechados"} automaticamente` : null,
    ac.geoTruncado ? `${ac.geoTruncado} GeoIntegrationCode(s) truncados` : null,
    ac.coordenadasLongas ? `${ac.coordenadasLongas} registro(s) com coordenadas longas` : null,
  ].filter(Boolean);
  if (compactados.length > 0) {
    const info = document.createElement("p");
    info.className = "placeholder";
    info.textContent = `Informativos: ${compactados.join(" · ")}.`;
    conversorResultado.appendChild(info);
  }

  if (r.problematicos.length > 0) {
    const titulo = document.createElement("h4");
    titulo.className = "conversor-problemas-titulo";
    titulo.textContent = `Registros com erro/aviso (${r.problematicos.length})`;
    conversorResultado.appendChild(titulo);

    const table = document.createElement("table");
    table.className = "tabela-saida";
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th></th><th>Registro</th><th>Código</th><th>Mensagens</th></tr>";
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    r.problematicos.forEach((p) => {
      const tr = document.createElement("tr");
      const tdStatus = document.createElement("td");
      tdStatus.textContent = p.erros.length ? "🔴" : "🟢";
      const tdInfo = document.createElement("td");
      const nomeLinha = document.createElement("div");
      nomeLinha.textContent = `#${p.indice} · ${p.nome}`;
      const tipoLinha = document.createElement("div");
      tipoLinha.className = "conversor-tipo-registro";
      tipoLinha.textContent = (p.tipoOriginal || "sem geometria") + (p.convertido ? " → Área" : "");
      tdInfo.appendChild(nomeLinha);
      tdInfo.appendChild(tipoLinha);
      const tdCodigo = document.createElement("td");
      tdCodigo.className = "conversor-codigo";
      tdCodigo.textContent = p.dados.GeoIntegrationCode || "";
      const tdMsg = document.createElement("td");
      tdMsg.className = "conversor-mensagens";
      tdMsg.textContent = kmlMensagens(p);
      [tdStatus, tdInfo, tdCodigo, tdMsg].forEach((td) => tr.appendChild(td));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    conversorResultado.appendChild(table);

    if (r.problematicosOcultos > 0) {
      const oculto = document.createElement("p");
      oculto.className = "placeholder";
      oculto.textContent = `... e mais ${r.problematicosOcultos} registro(s) com erro/aviso não exibido(s) aqui (os arquivos gerados já refletem todos).`;
      conversorResultado.appendChild(oculto);
    }
  }
}

btnConversorConverter.addEventListener("click", async () => {
  if (!estado.conversorArquivo) return;
  btnConversorConverter.disabled = true;
  btnConversorConverter.textContent = "Convertendo...";
  conversorResultado.innerHTML = "";
  try {
    const kmlText = await kmlLerArquivoConversor(estado.conversorArquivo);
    const tolTexto = conversorTolerancia.value.trim();
    const config = {
      categoria: conversorCategoria.value.trim() || undefined,
      grupo: conversorGrupo.value.trim() || undefined,
      tolerancia: tolTexto === "" ? undefined : Number(tolTexto),
      cor: estado.conversorCor === null ? undefined : estado.conversorCor,
      forcarAreas: conversorForcarAreas.checked,
    };
    conversorRegistrosOriginais = kmlProcessar(kmlText, config);
    conversorResultadoAtual = kmlMontarResultado(conversorRegistrosOriginais);
    renderConversorResultado();
  } catch (err) {
    mostrarErroConversor(err.message || String(err));
  } finally {
    btnConversorConverter.disabled = false;
    btnConversorConverter.textContent = "Converter arquivo";
  }
});

// --- Edição manual ---
// Uma linha por registro. Coordenadas só aparecem (não são editáveis): trocar o Tipo reaproveita as
// que já existem (fechando o anel quando vira Área) — nunca inventa nem descarta coordenada.
const overlayConversorEdicao = el("overlay-conversor-edicao");
const conversorEdicaoTitulo = el("conversor-edicao-titulo");
const conversorEdicaoTbody = el("conversor-edicao-tbody");
const conversorEdicaoTamanho = el("conversor-edicao-tamanho");
const conversorEdicaoPaginacao = el("conversor-edicao-paginacao");
const conversorEdicaoFeedback = el("conversor-edicao-feedback");
let conversorLinhasEdicao = [];
let conversorEdicaoPagina = 1;
let conversorEdicaoTimeout = null;

function kmlParaLinhaEdicao(r) {
  return {
    indice: r.indice,
    nome: r.nome,
    descricao: r.descricao,
    tipoOriginal: r.tipoOriginal,
    tipo: r.tipoFinal || r.tipoOriginal || "LineString",
    pontos: [...r.pontos],
    tolerancia: r.dados.Tolerance || "",
    geoCode: r.dados.GeoIntegrationCode || "",
    categoria: r.dados.CategoryIntegrationCode || "",
    grupo: r.dados.GroupIntegrationCode || "",
    cor: r.dados.ColorCode ? parseInt(r.dados.ColorCode, 10) : null,
    erros: [...r.erros],
    avisos: [...r.avisos],
  };
}

function kmlParaRegistroFinal(l) {
  const dados = {
    GeoIntegrationCode: l.geoCode.trim(),
    CategoryIntegrationCode: l.categoria.trim(),
    GroupIntegrationCode: l.grupo.trim(),
  };
  if (l.tolerancia.trim()) dados.Tolerance = l.tolerancia.trim();
  if (l.cor) dados.ColorCode = String(l.cor);
  return {
    indice: l.indice,
    nome: l.nome.trim(),
    descricao: l.descricao.trim(),
    tipoOriginal: l.tipoOriginal,
    tipoFinal: l.tipo,
    convertido: l.tipoOriginal !== null && l.tipo !== l.tipoOriginal,
    pontos: l.pontos,
    dados,
    avisos: l.avisos,
    erros: l.erros,
  };
}

// Revalida só a linha alterada. Tipo incompatível com o nº de coordenadas vira erro (não trunca
// nem gera coordenada); a única exceção é fechar o anel da Área com a 1ª coordenada existente.
function kmlRevalidarLinha(l) {
  const erros = [];
  const avisos = [];
  if (l.tipo === "Point") {
    if (l.pontos.length !== 1) {
      erros.push(
        `'Ponto' aceita só 1 coordenada — este registro tem ${l.pontos.length}. Coordenadas não são ` +
          "editáveis aqui: escolha outro tipo ou ajuste o KML original."
      );
    }
  } else if (l.tipo === "Polygon") {
    if (l.pontos.length > 0 && l.pontos[0] !== l.pontos[l.pontos.length - 1]) {
      l.pontos = [...l.pontos, l.pontos[0]];
      avisos.push("Polígono fechado automaticamente (ponto inicial repetido no final).");
    }
    const distintos = new Set(l.pontos).size;
    if (distintos < 3) {
      erros.push(`'Área' exige no mínimo 3 coordenadas distintas — este registro tem ${distintos}. Escolha outro tipo ou ajuste o KML original.`);
    }
  } else if (l.tipo === "LineString" && l.pontos.length < 2) {
    erros.push(`'Rota' exige no mínimo 2 coordenadas — este registro tem ${l.pontos.length}. Escolha outro tipo ou ajuste o KML original.`);
  }

  if (l.tipoOriginal && l.tipo !== l.tipoOriginal) {
    avisos.push(`Tipo alterado manualmente: ${KML_TIPO_LABEL[l.tipoOriginal]} → ${KML_TIPO_LABEL[l.tipo]}.`);
  }
  if (!l.nome.trim()) erros.push("'Nome' não pode ficar vazio.");
  else if (l.nome.length > KML_MAX_NAME) erros.push(`'Nome' excede ${KML_MAX_NAME} caracteres.`);
  if (l.descricao.length > KML_MAX_DESCRIPTION) erros.push(`'Descrição' excede ${KML_MAX_DESCRIPTION} caracteres.`);
  if (!l.categoria.trim()) erros.push("'Cod.categoria' é obrigatório.");
  else if (l.categoria.length > KML_MAX_CATEGORY_CODE) erros.push(`'Cod.categoria' excede ${KML_MAX_CATEGORY_CODE} caracteres.`);
  if (!l.grupo.trim()) erros.push("'Cod.grupo' é obrigatório.");
  else if (l.grupo.length > KML_MAX_GROUP_CODE) erros.push(`'Cod.grupo' excede ${KML_MAX_GROUP_CODE} caracteres.`);
  if (l.tipo === "Point" && !l.tolerancia.trim()) erros.push("'Tolerância' é obrigatória para o tipo Ponto.");
  else if (l.tolerancia.trim() && !/^-?\d+$/.test(l.tolerancia.trim())) erros.push("'Tolerância' deve ser um número inteiro (metros).");
  if (!l.geoCode.trim()) erros.push("'Cod.integração' é obrigatório.");
  else if (l.geoCode.length > KML_MAX_GEO_CODE) erros.push(`'Cod.integração' excede ${KML_MAX_GEO_CODE} caracteres.`);

  l.erros = erros;
  l.avisos = avisos;
}

function conversorEdicaoTotalPaginas() {
  return Math.max(1, Math.ceil(conversorLinhasEdicao.length / Number(conversorEdicaoTamanho.value)));
}

// Monta (ou remonta) uma linha da tabela de edição; mudanças revalidam e redesenham só ela.
function montarLinhaEdicao(l) {
  const tr = document.createElement("tr");
  if (l.erros.length > 0) tr.classList.add("conversor-edicao-linha-erro");

  const atualizar = () => {
    kmlRevalidarLinha(l);
    tr.replaceWith(montarLinhaEdicao(l));
  };
  const tdInput = (campo, classe) => {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.value = l[campo];
    if (classe) input.className = classe;
    input.addEventListener("input", () => {
      l[campo] = input.value;
    });
    input.addEventListener("change", atualizar);
    td.appendChild(input);
    return td;
  };

  tr.appendChild(tdInput("nome"));
  tr.appendChild(tdInput("descricao"));

  const tdTipo = document.createElement("td");
  tdTipo.className = "conversor-edicao-col-tipo";
  const select = document.createElement("select");
  KML_TIPO_OPCOES.forEach(({ value, label }) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  });
  select.value = l.tipo;
  select.addEventListener("change", () => {
    l.tipo = select.value;
    atualizar();
  });
  tdTipo.appendChild(select);
  tr.appendChild(tdTipo);

  const tdCoords = document.createElement("td");
  tdCoords.className = "conversor-edicao-col-coords";
  tdCoords.textContent = `${l.pontos.length} ${l.pontos.length === 1 ? "ponto" : "pontos"}`;
  tdCoords.title = l.pontos.join(" ");
  tr.appendChild(tdCoords);

  tr.appendChild(tdInput("tolerancia", "conversor-edicao-estreito"));
  tr.appendChild(tdInput("geoCode"));
  tr.appendChild(tdInput("categoria"));
  tr.appendChild(tdInput("grupo"));

  const tdCor = document.createElement("td");
  const grupoCores = document.createElement("div");
  grupoCores.className = "conversor-cor-mini-grupo";
  [{ codigo: null, hex: null }, ...CORES_SSX].forEach(({ codigo, hex }) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "conversor-cor-mini" + (codigo === null ? " conversor-cor-mini-nenhuma" : "");
    if (hex) b.style.background = hex;
    b.textContent = codigo === null ? "1" : String(codigo);
    b.title = codigo === null ? "Padrão (1)" : `Código ${codigo} (${hex})`;
    if (l.cor === codigo) b.classList.add("selecionada");
    b.addEventListener("click", () => {
      l.cor = codigo;
      atualizar();
    });
    grupoCores.appendChild(b);
  });
  tdCor.appendChild(grupoCores);
  tr.appendChild(tdCor);

  const tdStatus = document.createElement("td");
  tdStatus.className = "conversor-edicao-col-status";
  if (l.erros.length > 0) tdStatus.classList.add("status-erro");
  else if (l.avisos.length > 0) tdStatus.classList.add("status-aviso");
  tdStatus.textContent = kmlMensagens(l) || "OK";
  tr.appendChild(tdStatus);
  return tr;
}

function renderEdicaoConversor() {
  conversorEdicaoTitulo.textContent = `Edição manual — ${conversorLinhasEdicao.length} registro(s)`;
  const tamanho = Number(conversorEdicaoTamanho.value);
  conversorEdicaoPagina = Math.min(Math.max(1, conversorEdicaoPagina), conversorEdicaoTotalPaginas());
  const inicio = (conversorEdicaoPagina - 1) * tamanho;
  conversorEdicaoTbody.innerHTML = "";
  conversorLinhasEdicao.slice(inicio, inicio + tamanho).forEach((l) => conversorEdicaoTbody.appendChild(montarLinhaEdicao(l)));

  conversorEdicaoPaginacao.innerHTML = "";
  const total = conversorEdicaoTotalPaginas();
  if (total > 1) {
    const anterior = document.createElement("button");
    anterior.type = "button";
    anterior.className = "btn-secondary";
    anterior.textContent = "‹ Anterior";
    anterior.disabled = conversorEdicaoPagina === 1;
    anterior.addEventListener("click", () => {
      conversorEdicaoPagina--;
      renderEdicaoConversor();
    });
    const info = document.createElement("span");
    info.textContent = `Página ${conversorEdicaoPagina} de ${total}`;
    const proxima = document.createElement("button");
    proxima.type = "button";
    proxima.className = "btn-secondary";
    proxima.textContent = "Próxima ›";
    proxima.disabled = conversorEdicaoPagina === total;
    proxima.addEventListener("click", () => {
      conversorEdicaoPagina++;
      renderEdicaoConversor();
    });
    [anterior, info, proxima].forEach((n) => conversorEdicaoPaginacao.appendChild(n));
  }
}

function feedbackEdicaoConversor(mensagem, tipo) {
  conversorEdicaoFeedback.textContent = `${tipo === "erro" ? "⚠️" : tipo === "info" ? "↺" : "✔️"} ${mensagem}`;
  conversorEdicaoFeedback.className = `conversor-edicao-feedback conversor-edicao-feedback-${tipo}`;
  clearTimeout(conversorEdicaoTimeout);
  conversorEdicaoTimeout = setTimeout(() => conversorEdicaoFeedback.classList.add("hidden"), 5000);
}

function abrirEdicaoConversor() {
  if (!conversorResultadoAtual) return;
  conversorLinhasEdicao = conversorResultadoAtual.registros.map(kmlParaLinhaEdicao);
  conversorEdicaoPagina = 1;
  conversorEdicaoFeedback.classList.add("hidden");
  renderEdicaoConversor();
  overlayConversorEdicao.classList.remove("hidden");
}

function fecharEdicaoConversor() {
  overlayConversorEdicao.classList.add("hidden");
}

conversorEdicaoTamanho.addEventListener("change", () => {
  conversorEdicaoPagina = 1;
  renderEdicaoConversor();
});
el("conversor-edicao-fechar-x").addEventListener("click", fecharEdicaoConversor);
el("btn-conversor-edicao-fechar").addEventListener("click", fecharEdicaoConversor);
overlayConversorEdicao.addEventListener("click", (e) => {
  if (e.target === overlayConversorEdicao) fecharEdicaoConversor();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !overlayConversorEdicao.classList.contains("hidden")) fecharEdicaoConversor();
});

el("btn-conversor-edicao-aplicar").addEventListener("click", () => {
  conversorResultadoAtual = kmlMontarResultado(conversorLinhasEdicao.map(kmlParaRegistroFinal));
  renderConversorResultado();
  const r = conversorResultadoAtual;
  feedbackEdicaoConversor(
    r.nErro > 0
      ? `Alterações aplicadas — ${r.nOk} pronto(s), ${r.nErro} ainda com erro.`
      : `Alterações aplicadas — ${r.nOk} registro(s) pronto(s) para importar.`,
    r.nErro > 0 ? "erro" : "sucesso"
  );
});

el("btn-conversor-edicao-reverter").addEventListener("click", () => {
  if (!conversorRegistrosOriginais) return;
  conversorResultadoAtual = kmlMontarResultado(conversorRegistrosOriginais);
  renderConversorResultado();
  conversorLinhasEdicao = conversorResultadoAtual.registros.map(kmlParaLinhaEdicao);
  conversorEdicaoPagina = 1;
  renderEdicaoConversor();
  const r = conversorResultadoAtual;
  feedbackEdicaoConversor(
    `Revertido — voltou para o resultado original da conversão (${r.nOk} pronto(s), ${r.nErro} com erro).`,
    "info"
  );
});

// --- CONVERSOR DE CLIENTES -> SSX ---
// Sub-tela "/ferramentas/conversor-clientes": upload -> mapear colunas ->
// ajustar/transformar -> validar -> exportar. Diferente do conversor KML (que
// roda 100% no navegador), aqui o processamento roda no servidor
// (conversor_clientes.py + validador_importacao/) — reaproveita o motor de
// validação em Python como única fonte de verdade das ~30 regras oficiais da
// SSX, em vez de duplicar tudo em JS.
const convcliInputArquivo = el("convcli-input-arquivo");
const convcliArquivoNome = el("convcli-arquivo-nome");
const convcliSecaoMapeamento = el("convcli-secao-mapeamento");
const convcliMapaCampos = el("convcli-mapa-campos");
const convcliMapaResumo = el("convcli-mapa-resumo");
const convcliMapaResumoTexto = el("convcli-mapa-resumo-texto");
const convcliMapaDetalhe = el("convcli-mapa-detalhe");
const btnConvcliMapear = el("btn-convcli-mapear");
const convcliSecaoTrabalho = el("convcli-secao-trabalho");
const convcliResumo = el("convcli-resumo");
const convcliTabelaThead = el("convcli-tabela-thead");
const convcliTabelaTbody = el("convcli-tabela-tbody");
const convcliTabelaElemento = convcliTabelaThead.closest("table");
const convcliTamanhoPagina = el("convcli-tamanho-pagina");
const convcliPaginacao = el("convcli-paginacao");
const convcliTabelaArea = el("convcli-tabela-area");
const CONVCLI_LARGURAS_KEY = "larguraColunas_convcliClientes";

// A área da tabela (ver .convcli-tabela-area no CSS) ocupa a altura visível
// de main.conteudo — não dá pra resolver só com flex/CSS porque os
// ancestrais entre main.conteudo e esta área (.panel, .ferramentas-subtela,
// .convcli-secao) são blocos comuns a outras sub-telas de Ferramentas e não
// podem virar flex de altura esticada só por causa desta. Reage a resize da
// janela E a mudanças no próprio main.conteudo (ex.: sidebar recolhendo não
// muda a altura, mas é barato observar mesmo assim).
const elConteudoPrincipal = document.querySelector("main.conteudo");
function ajustarAlturaConvcliTabelaArea() {
  if (!convcliTabelaArea || !elConteudoPrincipal) return;
  // -24 = o margin-top da área (ver CSS) — sem descontar, margem + altura
  // passariam do espaço disponível e sobrariam 24px de rolagem "fantasma".
  convcliTabelaArea.style.height = `${elConteudoPrincipal.clientHeight - 24}px`;
}
if (elConteudoPrincipal && window.ResizeObserver) {
  new ResizeObserver(ajustarAlturaConvcliTabelaArea).observe(elConteudoPrincipal);
}
window.addEventListener("resize", ajustarAlturaConvcliTabelaArea);

let convcliFileId = null;
let convcliColunasOrigem = [];
let convcliCampos = [];          // definição oficial (chave, rótulo, obrigatório, tipo, tamanho_max)
let convcliCamposMapeados = [];  // subconjunto de convcliCampos que entrou no mapeamento aplicado
let convcliRegistros = [];       // [{indice, original, dados}]
let convcliProblemasPorIndice = {}; // {indice: {erros:[...], avisos:[...]}}, populado por /validar
let convcliDuplicadosPorIndice = {}; // idem, mas populado por /verificar-duplicidade (SSX) — store separado pra um não apagar o outro
let convcliNomeBase = "clientes";
let convcliPagina = 1;
let convcliOrdenacao = null; // { chave: "indice" | <campo.chave>, direcao: 1 | -1 }

// Autenticação na SSX pra "Verificar na SSX": de propósito NÃO reaproveita
// estado.autenticado (sessão global, que sobrevive a F5 via cookie) — aqui a
// confirmação é só pra ESTA planilha carregada nesta aba. Começa falso
// sempre (recarregar a página já zera isso sozinho, só por ser variável de
// JS) e volta a falso ao trocar de arquivo — melhor pedir login de novo
// vezes demais do que arriscar verificar/importar com a sessão errada.
let convcliSsxOk = false;
let convcliSsxLogin = "";
let convcliSsxBase = "";
let convcliSsxClaimsRaw = null;

function convcliAtualizarPillAuth() {
  const pill = el("convcli-status-auth");
  const btnLogout = el("btn-convcli-logout-ssx");
  if (convcliSsxOk) {
    pill.textContent = convcliSsxLogin
      ? `Autenticado na SSX (${convcliSsxLogin}${convcliSsxBase ? " — " + convcliSsxBase : ""})`
      : "Autenticado na SSX";
    pill.title = convcliSsxClaimsRaw ? JSON.stringify(convcliSsxClaimsRaw) : "";
    pill.className = "status-pill status-on";
    btnLogout.classList.remove("hidden");
  } else {
    pill.textContent = "Não autenticado na SSX";
    pill.className = "status-pill status-off";
    btnLogout.classList.add("hidden");
  }
}

function limparConvcli() {
  convcliFileId = null;
  convcliColunasOrigem = [];
  convcliCamposMapeados = [];
  convcliRegistros = [];
  convcliProblemasPorIndice = {};
  convcliDuplicadosPorIndice = {};
  convcliSsxOk = false;
  convcliSsxLogin = "";
  convcliSsxBase = "";
  convcliSsxClaimsRaw = null;
  convcliAtualizarPillAuth();
  convcliNomeBase = "clientes";
  convcliPagina = 1;
  convcliOrdenacao = null;
  convcliInputArquivo.value = "";
  convcliArquivoNome.textContent = "Nenhum arquivo selecionado";
  convcliSecaoMapeamento.classList.add("hidden");
  convcliSecaoTrabalho.classList.add("hidden");
  convcliMapaResumo.classList.add("hidden");
  convcliMapaDetalhe.classList.remove("hidden");
  convcliMapaCampos.innerHTML = "";
  convcliResumo.innerHTML = "";
  convcliTabelaThead.innerHTML = "";
  convcliTabelaTbody.innerHTML = "";
  convcliPaginacao.innerHTML = "";
  btnConvcliMapear.disabled = true;
}
limparConvcli();

function mostrarErroConvcli(msg) {
  convcliResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  convcliResumo.appendChild(p);
}

function mostrarInfoConvcli(msg) {
  convcliResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = msg;
  convcliResumo.appendChild(p);
}

async function carregarConvcliCampos() {
  if (convcliCampos.length) return convcliCampos;
  const r = await fetch("/api/conversor-clientes/campos");
  const data = await parseJsonResponse(r);
  if (!data.ok) throw new Error(data.error || "Falha ao carregar os campos da SSX.");
  convcliCampos = data.campos;
  return convcliCampos;
}

// Mapeamento padrão: posicional, pela ordem oficial do manual da SSX (campo 1
// do manual <- coluna 1 da planilha enviada, campo 2 <- coluna 2, ...) —
// independente do nome que a coluna tem na planilha de origem. Se a planilha
// tiver menos colunas que os 30 campos oficiais, os campos que sobram (sempre
// os últimos da ordem oficial) ficam sem sugestão — a usuária ajusta na mão o
// que precisar.
function renderConvcliMapaCampos() {
  convcliMapaCampos.innerHTML = "";
  convcliCampos.forEach((campo, i) => {
    const linha = document.createElement("div");
    linha.className = "convcli-mapa-linha";

    const nome = document.createElement("span");
    nome.className = "convcli-mapa-nome";
    const marca = campo.obrigatorio === true ? " *" : campo.obrigatorio === "condicional" ? " (condicional)" : "";
    nome.textContent = campo.rotulo + marca;
    nome.title = campo.rotulo + marca; // rótulo pode truncar na coluna estreita — mostra inteiro no hover

    const select = document.createElement("select");
    select.dataset.campo = campo.chave;
    const optVazio = document.createElement("option");
    optVazio.value = "";
    optVazio.textContent = "— não mapear —";
    select.appendChild(optVazio);
    convcliColunasOrigem.forEach((col) => {
      const opt = document.createElement("option");
      opt.value = col;
      opt.textContent = col;
      select.appendChild(opt);
    });
    if (convcliColunasOrigem[i] !== undefined) select.value = convcliColunasOrigem[i];

    linha.appendChild(nome);
    linha.appendChild(select);
    convcliMapaCampos.appendChild(linha);
  });
}

el("btn-convcli-mapear-limpar").addEventListener("click", () => {
  convcliMapaCampos.querySelectorAll("select").forEach((sel) => { sel.value = ""; });
});

// Mesma regra posicional do preenchimento inicial (coluna 1 -> campo 1, ...) —
// pra voltar pro automático depois de limpar ou mexer manualmente.
el("btn-convcli-mapear-auto").addEventListener("click", () => {
  convcliMapaCampos.querySelectorAll("select").forEach((sel, i) => {
    sel.value = convcliColunasOrigem[i] !== undefined ? convcliColunasOrigem[i] : "";
  });
});

el("btn-convcli-mapa-editar").addEventListener("click", () => {
  convcliMapaResumo.classList.add("hidden");
  convcliMapaDetalhe.classList.remove("hidden");
});

convcliInputArquivo.addEventListener("change", async () => {
  const file = convcliInputArquivo.files[0];
  if (!file) return;
  convcliArquivoNome.textContent = "Enviando...";
  convcliSecaoTrabalho.classList.add("hidden");
  convcliSecaoMapeamento.classList.add("hidden");
  // Trocou de planilha — some com a confirmação de SSX anterior, nem que seja
  // o mesmo arquivo reenviado: melhor pedir login de novo do que arriscar
  // verificar/importar com a sessão errada (ver convcliSsxOk acima).
  convcliSsxOk = false;
  convcliDuplicadosPorIndice = {};
  convcliAtualizarPillAuth();
  convcliTemplatesResultado = null;
  try {
    await carregarConvcliCampos();
    const formData = new FormData();
    formData.append("arquivo", file);
    const r = await fetch("/api/conversor-clientes/upload", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      convcliArquivoNome.textContent = "Nenhum arquivo selecionado";
      return mostrarErroConvcli(data.error || "Falha ao enviar arquivo.");
    }
    convcliFileId = data.file_id;
    convcliColunasOrigem = data.colunas;
    convcliNomeBase = file.name.replace(/\.(xlsx|xls|csv)$/i, "");
    convcliArquivoNome.textContent = `${file.name} (${data.total_linhas} linha(s))`;
    renderConvcliMapaCampos();
    convcliSecaoMapeamento.classList.remove("hidden");
    btnConvcliMapear.disabled = false;
  } catch (err) {
    convcliArquivoNome.textContent = "Nenhum arquivo selecionado";
    mostrarErroConvcli(err.message || String(err));
  }
});

btnConvcliMapear.addEventListener("click", async () => {
  const mapping = {};
  convcliMapaCampos.querySelectorAll("select").forEach((sel) => {
    if (sel.value) mapping[sel.dataset.campo] = sel.value;
  });
  if (Object.keys(mapping).length === 0) {
    return mostrarErroConvcli("Mapeie ao menos uma coluna antes de continuar.");
  }
  btnConvcliMapear.disabled = true;
  btnConvcliMapear.textContent = "Aplicando...";
  try {
    const r = await fetch("/api/conversor-clientes/mapear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcliFileId, mapping }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvcli(data.error || "Falha ao aplicar o mapeamento.");
    convcliRegistros = data.registros;
    convcliCamposMapeados = convcliCampos.filter((c) => mapping[c.chave]);
    convcliProblemasPorIndice = {};
    convcliDuplicadosPorIndice = {};
    convcliPagina = 1;
    convcliOrdenacao = null;
    convcliSecaoTrabalho.classList.remove("hidden");
    ajustarAlturaConvcliTabelaArea();
    renderConvcliTabelaCabecalho();
    renderConvcliTabela();
    // Validação local (motor oficial + duplicidade dentro da planilha) já
    // roda sozinha aqui — só "Verificar na SSX" continua precisando de
    // clique manual (depende de login/rede, não dá pra disparar sozinho).
    await rodarValidacaoConvcli();

    // Recolhe o mapeamento depois de aplicado — a grade de 30 campos some e
    // sobra só um resumo + "Editar mapeamento", liberando a tela pra tabela
    // (senão a barra de rolagem horizontal ficava lá embaixo, fora da vista).
    const n = convcliCamposMapeados.length;
    convcliMapaResumoTexto.textContent = `${n} campo${n === 1 ? "" : "s"} mapeado${n === 1 ? "" : "s"}.`;
    convcliMapaDetalhe.classList.add("hidden");
    convcliMapaResumo.classList.remove("hidden");
  } catch (err) {
    mostrarErroConvcli(err.message || String(err));
  } finally {
    btnConvcliMapear.disabled = false;
    btnConvcliMapear.textContent = "Aplicar mapeamento";
  }
});

// Ordenação por coluna: clique alterna crescente ("menor pro maior"/A-Z) e
// decrescente, mesmo padrão visual (th-ordenavel/seta-ordenacao) das outras
// tabelas do app (ver valorOrdenavel/ordenarLinhas, linha ~116).
function convcliValorColuna(registro, chave) {
  return chave === "indice" ? registro.indice : registro.dados[chave];
}

function ordenarConvcliRegistros(registros) {
  if (!convcliOrdenacao) return registros;
  const { chave, direcao } = convcliOrdenacao;
  return registros.slice().sort((a, b) => {
    const va = valorOrdenavel(convcliValorColuna(a, chave));
    const vb = valorOrdenavel(convcliValorColuna(b, chave));
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * direcao;
    return String(va).localeCompare(String(vb), "pt-BR", { numeric: true, sensitivity: "base" }) * direcao;
  });
}

function renderConvcliTabelaCabecalho() {
  convcliTabelaThead.innerHTML = "";
  const tr = document.createElement("tr");

  const criarThOrdenavel = (texto, chave, larguraPadrao) => {
    const th = document.createElement("th");
    th.className = "th-ordenavel";
    th.style.width = `${larguraPadrao}px`; // ponto de partida; tornarColunasRedimensionaveis troca pela largura salva, se tiver
    th.textContent = texto;
    if (convcliOrdenacao && convcliOrdenacao.chave === chave) {
      const seta = document.createElement("span");
      seta.className = "seta-ordenacao";
      seta.textContent = convcliOrdenacao.direcao === 1 ? " ▲" : " ▼";
      th.appendChild(seta);
    }
    th.addEventListener("click", () => {
      const direcao = convcliOrdenacao && convcliOrdenacao.chave === chave ? -convcliOrdenacao.direcao : 1;
      convcliOrdenacao = { chave, direcao };
      convcliPagina = 1;
      renderConvcliTabelaCabecalho();
      renderConvcliTabela();
    });
    return th;
  };

  tr.appendChild(criarThOrdenavel("#", "indice", 60));
  convcliCamposMapeados.forEach((campo) => tr.appendChild(criarThOrdenavel(campo.rotulo, campo.chave, 180)));

  // Coluna de ações (excluir linha) — sem ordenação, só o botão.
  const thAcoes = document.createElement("th");
  thAcoes.style.width = "46px";
  thAcoes.textContent = "";
  tr.appendChild(thAcoes);

  convcliTabelaThead.appendChild(tr);
}

function convcliTotalPaginas() {
  return Math.max(1, Math.ceil(convcliRegistros.length / Number(convcliTamanhoPagina.value)));
}

// Mescla a validação local (/validar) com a duplicidade da SSX
// (/verificar-duplicidade) — stores separados (um não apaga o outro ao
// rodar de novo), combinados só na hora de exibir.
function convcliProblemaCombinado(indice) {
  const a = convcliProblemasPorIndice[indice];
  const b = convcliDuplicadosPorIndice[indice];
  if (!a && !b) return null;
  return {
    erros: [...(a ? a.erros : []), ...(b ? b.erros : [])],
    avisos: [...(a ? a.avisos : []), ...(b ? b.avisos : [])],
  };
}

function montarLinhaConvcli(registro) {
  const tr = document.createElement("tr");
  tr.dataset.indice = registro.indice; // usado por irParaPrimeiroErroConvcli pra achar a linha depois de re-renderizar
  const problema = convcliProblemaCombinado(registro.indice);

  const tdIndice = document.createElement("td");
  let icone = "";
  if (problema && problema.erros.length > 0) {
    icone = "🔴 ";
    tr.classList.add("conversor-edicao-linha-erro");
  } else if (problema && problema.avisos.length > 0) {
    icone = "⚠️ ";
  } else if (problema) {
    icone = "✓ ";
  }
  tdIndice.textContent = icone + registro.indice;
  if (problema) {
    const msgs = [...problema.erros.map((e) => `⛔ ${e.mensagem}`), ...problema.avisos.map((a) => `⚠️ ${a.mensagem}`)];
    tr.title = msgs.join("\n");
  }
  tr.appendChild(tdIndice);

  // Duplicata marca o PRÓPRIO campo, não só o ícone da linha — mais fácil de
  // ver qual valor exato está repetido. Duas cores conforme a gravidade:
  // "duplicado_ssx" (vermelho) = já existe um cliente ATIVO na SSX com esse
  // valor; "duplicado_planilha" (amarelo) = só se repete dentro da própria
  // planilha sendo importada agora (pode ser coincidência). Mapeia por
  // rótulo do campo porque é assim que vem em "campo" nos avisos (ver
  // verificar_duplicidade_ssx/verificar_duplicidade_interna em
  // conversor_clientes.py — mesmo rótulo de CampoSpec.rotulo). Processa SSX
  // por último de propósito: se os dois baterem no mesmo campo, o vermelho
  // (mais grave) prevalece sobre o amarelo.
  const duplicadosPorCampo = {};
  if (problema) {
    const todos = [...problema.erros, ...problema.avisos];
    todos.filter((p) => p.categoria === "duplicado_planilha").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
    todos.filter((p) => p.categoria === "duplicado_ssx").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
  }

  convcliCamposMapeados.forEach((campo) => {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.value = registro.dados[campo.chave] || "";
    const duplicado = duplicadosPorCampo[campo.rotulo];
    if (duplicado) {
      input.classList.add(duplicado.categoria === "duplicado_ssx" ? "convcli-campo-duplicado" : "convcli-campo-duplicado-planilha");
      input.title = duplicado.mensagem;
    }
    input.addEventListener("change", async () => {
      registro.dados[campo.chave] = input.value;
      try {
        const r = await fetch("/api/conversor-clientes/editar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: convcliFileId, indice: registro.indice, campo: campo.chave, valor: input.value }),
        });
        const data = await parseJsonResponse(r);
        if (!data.ok) return mostrarErroConvcli(data.error || "Falha ao salvar a edição.");
        // Validação local (duplicidade dentro da planilha incluída) roda de
        // novo sozinha a cada edição — "em tempo real", sem precisar clicar
        // em "Validar planilha". Só "Verificar na SSX" continua manual.
        await rodarValidacaoConvcli();
      } catch (err) {
        mostrarErroConvcli(err.message || String(err));
      }
    });
    td.appendChild(input);
    tr.appendChild(td);
  });

  const tdAcoes = document.createElement("td");
  tdAcoes.className = "convcli-td-acoes";
  const btnExcluir = document.createElement("button");
  btnExcluir.type = "button";
  btnExcluir.className = "btn-secondary convcli-btn-excluir-linha";
  btnExcluir.textContent = "🗑️";
  btnExcluir.title = "Excluir esta linha";
  btnExcluir.addEventListener("click", () => excluirLinhaConvcli(registro.indice));
  tdAcoes.appendChild(btnExcluir);
  tr.appendChild(tdAcoes);

  return tr;
}

function renderConvcliTabela() {
  const tamanho = Number(convcliTamanhoPagina.value);
  const registrosOrdenados = ordenarConvcliRegistros(convcliRegistros);
  convcliPagina = Math.min(Math.max(1, convcliPagina), convcliTotalPaginas());
  const inicio = (convcliPagina - 1) * tamanho;
  convcliTabelaTbody.innerHTML = "";
  registrosOrdenados.slice(inicio, inicio + tamanho).forEach((r) => convcliTabelaTbody.appendChild(montarLinhaConvcli(r)));
  // Larguras de coluna arrastáveis, igual Excel — tbody é recriado a cada
  // página/transformação/validação, por isso chama de novo a cada vez aqui
  // (a função é idempotente: não duplica alça, só reaplica largura salva).
  tornarColunasRedimensionaveis(convcliTabelaElemento, CONVCLI_LARGURAS_KEY);

  convcliPaginacao.innerHTML = "";
  const total = convcliTotalPaginas();
  if (total > 1) {
    const anterior = document.createElement("button");
    anterior.type = "button";
    anterior.className = "btn-secondary";
    anterior.textContent = "‹ Anterior";
    anterior.disabled = convcliPagina === 1;
    anterior.addEventListener("click", () => { convcliPagina--; renderConvcliTabela(); });
    const info = document.createElement("span");
    info.textContent = `Página ${convcliPagina} de ${total}`;
    const proxima = document.createElement("button");
    proxima.type = "button";
    proxima.className = "btn-secondary";
    proxima.textContent = "Próxima ›";
    proxima.disabled = convcliPagina === total;
    proxima.addEventListener("click", () => { convcliPagina++; renderConvcliTabela(); });
    [anterior, info, proxima].forEach((n) => convcliPaginacao.appendChild(n));
  }
}
convcliTamanhoPagina.addEventListener("change", () => { convcliPagina = 1; renderConvcliTabela(); });

// --- EXCLUIR / ADICIONAR LINHA ---
async function excluirLinhaConvcli(indice) {
  if (!convcliFileId) return;
  if (!confirm(`Excluir a linha ${indice}? Essa ação não pode ser desfeita.`)) return;
  try {
    const r = await fetch("/api/conversor-clientes/excluir-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcliFileId, indice }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvcli(data.error || "Falha ao excluir a linha.");
    convcliRegistros = convcliRegistros.filter((r2) => r2.indice !== indice);
    delete convcliDuplicadosPorIndice[indice];
    // Revalida tudo (não só tira a linha excluída do dict): excluir pode
    // "limpar" uma duplicata que só existia por causa dela — ex. se a linha
    // excluída era a 1ª ocorrência de um nome repetido, a que restou deixa
    // de ser duplicata depois que ela sai.
    await rodarValidacaoConvcli();
    mostrarInfoConvcli(`Linha ${indice} excluída.`);
  } catch (err) {
    mostrarErroConvcli(err.message || String(err));
  }
}

el("btn-convcli-adicionar-linha").addEventListener("click", async () => {
  if (!convcliFileId) return;
  try {
    const r = await fetch("/api/conversor-clientes/adicionar-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcliFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvcli(data.error || "Falha ao adicionar a linha.");
    convcliRegistros.push(data.registro);
    // Sem ordenação ativa a linha nova sempre cai no fim — com ordenação
    // ativa, a posição dela ia depender dos valores (todos vazios) de um
    // jeito pouco previsível; mais simples voltar pra ordem natural aqui.
    convcliOrdenacao = null;
    renderConvcliTabelaCabecalho();
    convcliPagina = convcliTotalPaginas(); // pula pra última página, onde a linha nova vai aparecer
    // Já valida — linha nova costuma faltar campo obrigatório (ex.: nome,
    // código de integração), fica visível de cara sem precisar editar nada
    // primeiro pra só então descobrir.
    await rodarValidacaoConvcli();
    mostrarInfoConvcli(`Linha ${data.registro.indice} adicionada — preencha os campos.`);
  } catch (err) {
    mostrarErroConvcli(err.message || String(err));
  }
});

el("btn-convcli-limpar-vazias").addEventListener("click", async () => {
  if (!convcliFileId) return;
  try {
    const r = await fetch("/api/conversor-clientes/limpar-vazias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcliFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvcli(data.error || "Falha ao limpar as linhas vazias.");
    convcliRegistros = convcliRegistros.filter((reg) => Object.values(reg.dados).some((v) => (v || "").trim()));
    convcliPagina = 1;
    await rodarValidacaoConvcli();
    mostrarInfoConvcli(data.removidos ? `${data.removidos} linha(s) vazia(s) removida(s).` : "Nenhuma linha vazia encontrada.");
  } catch (err) {
    mostrarErroConvcli(err.message || String(err));
  }
});

// Transformações em massa (seção 6 do pedido): roda no servidor sobre TODAS as
// linhas mapeadas (seleção de linhas específicas fica pra uma próxima etapa) e
// devolve só os registros que mudaram, pra não precisar redesenhar tudo.
// `montarMensagem`, se passado, recebe a resposta inteira do servidor e monta
// a mensagem de resumo — sem ele, usa a mensagem genérica de sempre.
async function rodarTransformacaoConvcli(acao, params, montarMensagem) {
  if (!convcliFileId) return;
  try {
    const r = await fetch("/api/conversor-clientes/transformar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcliFileId, acao, params: params || {} }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvcli(data.error || "Falha ao aplicar a transformação.");
    const porIndice = new Map(data.registros.map((r2) => [r2.indice, r2]));
    convcliRegistros = convcliRegistros.map((r2) => porIndice.get(r2.indice) || r2);
    // Validação local roda de novo sozinha (duplicidade dentro da planilha
    // incluída) — a transformação pode ter mudado Nome/CPF/Login/etc. Já
    // redesenha a tabela sozinha, não precisa chamar renderConvcliTabela()
    // de novo aqui. Só "Verificar na SSX" continua manual.
    await rodarValidacaoConvcli();
    mostrarInfoConvcli(montarMensagem ? montarMensagem(data) : `${data.total_alterados} registro(s) alterado(s).`);
  } catch (err) {
    mostrarErroConvcli(err.message || String(err));
  }
}

el("btn-convcli-limpar-docs").addEventListener("click", () => rodarTransformacaoConvcli("limpar_documentos"));
el("btn-convcli-gerar-emails").addEventListener("click", () => {
  const dominio = el("convcli-dominio-email").value.trim();
  if (!dominio) return mostrarErroConvcli("Informe o domínio pra gerar os logins ausentes.");
  rodarTransformacaoConvcli("gerar_emails", { dominio });
});
el("btn-convcli-preencher-senhas").addEventListener("click", () => {
  const senha = el("convcli-senha-padrao").value.trim();
  if (!senha) return mostrarErroConvcli("Informe a senha a ser preenchida.");
  const sobrescrever = el("convcli-senha-sobrescrever").checked;
  rodarTransformacaoConvcli("preencher_senhas", { senha, sobrescrever });
});
el("btn-convcli-ajustar-tipo-pessoa").addEventListener("click", () => {
  rodarTransformacaoConvcli("ajustar_tipo_pessoa", {}, (data) =>
    `${data.pessoas_fisicas} pessoa(s) física(s), ${data.pessoas_juridicas} pessoa(s) jurídica(s) identificada(s)`
    + (data.indefinidos ? ` e ${data.indefinidos} linha(s) sem CPF/CNPJ reconhecível (correção manual).` : "."));
});
el("btn-convcli-separar-endereco").addEventListener("click", () => {
  rodarTransformacaoConvcli("separar_endereco", {}, (data) =>
    `${data.enderecos_separados} endereço(s) separado(s)`
    + (data.enderecos_ignorados ? ` e ${data.enderecos_ignorados} linha(s) sem endereço combinado reconhecível (já estava só a rua, ou vazio).` : "."));
});
el("btn-convcli-ajustar-telefones").addEventListener("click", () => {
  const dddPadrao = el("convcli-ddd-padrao").value.trim() || "55";
  rodarTransformacaoConvcli("ajustar_telefones", { ddd_padrao: dddPadrao }, (data) =>
    `${data.telefones_ajustados} telefone(s) ajustado(s)`
    + (data.telefones_nao_reconhecidos ? ` e ${data.telefones_nao_reconhecidos} número(s) com quantidade de dígitos não reconhecida (correção manual).` : "."));
});
el("btn-convcli-repetir-nome-usuario").addEventListener("click", () => {
  rodarTransformacaoConvcli("repetir_nome_usuario", {}, (data) => `${data.repetidos} nome(s) repetido(s) em Nome do usuário.`);
});
el("btn-convcli-repetir-codigo-pessoa").addEventListener("click", () => {
  rodarTransformacaoConvcli("repetir_codigo_integracao_pessoa", {}, (data) => `${data.repetidos} código(s) repetido(s) em Código integração pessoa.`);
});
el("btn-convcli-preencher-template").addEventListener("click", () => {
  const valor = el("convcli-template-cliente-valor").value.trim();
  if (!valor) return mostrarErroConvcli("Informe o template do cliente a ser preenchido.");
  rodarTransformacaoConvcli("preencher_template_cliente", { valor }, (data) => `${data.preenchidos} linha(s) preenchida(s) com o template "${valor}".`);
});
el("btn-convcli-preencher-perfil").addEventListener("click", () => {
  const valor = el("convcli-perfil-acesso-valor").value.trim();
  if (!valor) return mostrarErroConvcli("Informe o perfil de acesso a ser preenchido.");
  rodarTransformacaoConvcli("preencher_perfil_acesso", { valor }, (data) => `${data.preenchidos} linha(s) preenchida(s) com o perfil "${valor}".`);
});

function renderConvcliResumo(data) {
  convcliResumo.innerHTML = "";
  const tiles = document.createElement("div");
  tiles.className = "dashboard-tiles";
  [
    { valor: data.n_ok, label: "Válidos" },
    { valor: data.n_erro, label: "Com erro", clicavel: data.n_erro > 0 },
  ].forEach(({ valor, label, clicavel }) => {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const l = document.createElement("div");
    l.className = "stat-tile-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "stat-tile-valor";
    v.textContent = valor;
    tile.appendChild(l);
    tile.appendChild(v);
    if (clicavel) {
      tile.classList.add("stat-tile-clicavel");
      tile.title = "Ir para o primeiro registro com erro";
      tile.addEventListener("click", irParaPrimeiroErroConvcli);
    }
    tiles.appendChild(tile);
  });
  convcliResumo.appendChild(tiles);
  const legenda = document.createElement("p");
  legenda.className = "placeholder";
  legenda.textContent = `${data.n_ok} de ${data.total} registro(s) válidos para importar.`;
  convcliResumo.appendChild(legenda);
}

// Pula pro primeiro registro com ERRO (não aviso), na mesma ordem em que a
// tabela está exibida agora (respeita ordenação por coluna, se tiver uma
// ativa) — troca de página se precisar e rola/realça a linha, pra não
// obrigar a usuária a caçar manualmente entre centenas de linhas.
function irParaPrimeiroErroConvcli() {
  const ordenados = ordenarConvcliRegistros(convcliRegistros);
  const posicao = ordenados.findIndex((r) => {
    const p = convcliProblemaCombinado(r.indice);
    return p && p.erros.length > 0;
  });
  if (posicao === -1) return;

  const tamanho = Number(convcliTamanhoPagina.value);
  convcliPagina = Math.floor(posicao / tamanho) + 1;
  renderConvcliTabela();

  const indice = ordenados[posicao].indice;
  const tr = convcliTabelaTbody.querySelector(`tr[data-indice="${indice}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: "smooth", block: "center" });
  tr.classList.add("convcli-linha-destacada");
  setTimeout(() => tr.classList.remove("convcli-linha-destacada"), 2200);
}

async function rodarValidacaoConvcli() {
  if (!convcliFileId) return null;
  try {
    const r = await fetch("/api/conversor-clientes/validar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcliFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvcli(data.error || "Falha ao validar.");
      return null;
    }
    convcliProblemasPorIndice = {};
    data.problemas.forEach((p) => { convcliProblemasPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvcliResumo(data);
    renderConvcliTabela();
    return data;
  } catch (err) {
    mostrarErroConvcli(err.message || String(err));
    return null;
  }
}
el("btn-convcli-validar").addEventListener("click", () => rodarValidacaoConvcli());

// --- VERIFICAR DUPLICIDADE NA SSX (opcional — exige login na API da SSX) ---
// O /api/login chamado aqui é o mesmo da Área de Importação e Consulta (POST
// /Login da SSX, token guardado na sessão Flask) — então dá pra reaproveitar
// os logins salvos e o próprio backend não muda nada. Mas a CONFIRMAÇÃO de
// "pode verificar/importar" (convcliSsxOk, acima) é local a esta tela e esta
// planilha: não confia num token de sessão que ainda esteja válido de uma
// aba/recarregamento anterior — sempre exige passar pelo modal de login de
// novo depois de F5 ou de trocar de arquivo, de propósito (ver convcliSsxOk).
// Como é opcional e não faz parte do fluxo normal (CSV), esse login só
// aparece quando a usuária de fato pede pra verificar, num modal próprio —
// não tem campo de login fixo na tela.
const overlayConvcliLogin = el("overlay-convcli-login");
const selectConvcliCredencial = el("convcli-select-credencial");

function renderSelectConvcliCredenciais() {
  selectConvcliCredencial.innerHTML = '<option value="">Login salvo...</option>';
  credenciaisCache.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.nome;
    selectConvcliCredencial.appendChild(opt);
  });
}

selectConvcliCredencial.addEventListener("change", () => {
  const cred = credenciaisCache.find((c) => c.id === selectConvcliCredencial.value);
  if (!cred) return;
  el("convcli-login").value = cred.login;
  el("convcli-senha").value = cred.senha;
  selectConvcliCredencial.value = "";
});

// Esse login é compartilhado por dois gatilhos ("Verificar na SSX" e
// "Importar via API") que precisam continuar em lugares diferentes depois de
// logar — null = padrão (verificar duplicidade); setado antes de abrir o
// overlay quando quem chamou precisa seguir pra outro lugar.
let convcliLoginAoEntrar = null;

el("convcli-login-fechar").addEventListener("click", () => {
  convcliLoginAoEntrar = null;
  overlayConvcliLogin.classList.add("hidden");
});

el("form-convcli-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const login = el("convcli-login").value.trim();
  const senha = el("convcli-senha").value;
  if (!login || !senha) return;
  const btn = el("btn-convcli-autenticar");
  btn.disabled = true;
  btn.textContent = "Entrando...";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, senha }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvcli(data.error || "Falha ao autenticar na SSX.");
      return;
    }
    convcliSsxOk = true;
    convcliSsxLogin = login;
    convcliSsxBase = extrairNomeBaseDeClaims(data.claims);
    convcliSsxClaimsRaw = data.claims || null;
    convcliAtualizarPillAuth();
    overlayConvcliLogin.classList.add("hidden");
    el("convcli-senha").value = "";
    const aoEntrar = convcliLoginAoEntrar;
    convcliLoginAoEntrar = null;
    if (aoEntrar) return await aoEntrar();
    await rodarVerificacaoDuplicidadeConvcli();
  } catch (err) {
    mostrarErroConvcli(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
});

el("btn-convcli-logout-ssx").addEventListener("click", async () => {
  await fetch("/api/logout-avulso", { method: "POST" });
  convcliSsxOk = false;
  convcliSsxLogin = "";
  convcliSsxBase = "";
  convcliSsxClaimsRaw = null;
  convcliAtualizarPillAuth();
  // Some com o resultado de "Verificar na SSX" (destaque vermelho) junto —
  // ele veio de uma sessão que acabou de ser encerrada, não faz sentido
  // continuar mostrando como se ainda valesse.
  convcliDuplicadosPorIndice = {};
  renderConvcliTabela();
  mostrarInfoConvcli("Sessão da SSX encerrada.");
});

async function rodarVerificacaoDuplicidadeConvcli() {
  if (!convcliFileId) return null;
  const btn = el("btn-convcli-verificar-ssx");
  btn.disabled = true;
  btn.textContent = "Verificando...";
  try {
    const r = await fetch("/api/conversor-clientes/verificar-duplicidade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcliFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (r.status === 401 || r.status === 409) {
        convcliSsxOk = false;
        convcliAtualizarPillAuth();
        renderSelectConvcliCredenciais();
        overlayConvcliLogin.classList.remove("hidden");
        return null;
      }
      mostrarErroConvcli(data.error || "Falha ao verificar duplicidade na SSX.");
      return null;
    }
    convcliDuplicadosPorIndice = {};
    data.problemas.forEach((p) => { convcliDuplicadosPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvcliTabela();
    mostrarInfoConvcli(
      data.total_duplicados
        ? `${data.total_duplicados} de ${data.total_verificados} registro(s) com possível duplicata na SSX (só clientes ativos são comparados).`
        : `Nenhuma duplicata encontrada entre os ${data.total_verificados} registro(s) verificados (só clientes ativos são comparados).`
    );
    return data;
  } catch (err) {
    mostrarErroConvcli(err.message || String(err));
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = "Verificar na SSX";
  }
}

el("btn-convcli-verificar-ssx").addEventListener("click", () => {
  if (!convcliFileId) return;
  if (!convcliSsxOk) {
    convcliLoginAoEntrar = null;
    renderSelectConvcliCredenciais();
    overlayConvcliLogin.classList.remove("hidden");
    return;
  }
  rodarVerificacaoDuplicidadeConvcli();
});

// Botão "Templates": lista o Template de cliente, a Unidade organizacional e
// o Perfil de acesso usados na planilha inteira — aparece SEMPRE, direto de
// convcliRegistros (já em memória), sem exigir login. Mesma ideia do botão
// equivalente do Conversor de Veículos (ver abrirModalConvveiTemplates
// acima) — a cor vermelha (⚠ "falta cadastrar") só aparece depois de
// "Verificar cadastro na SSX", que aí sim pede autenticação.
const overlayConvcliTemplates = el("overlay-convcli-templates");
const convcliTemplatesListaTemplates = el("convcli-templates-lista-templates");
const convcliTemplatesListaUos = el("convcli-templates-lista-uos");
const convcliTemplatesListaPerfis = el("convcli-templates-lista-perfis");
const convcliTemplatesLegenda = el("convcli-templates-legenda");
// null = ainda não verificado na SSX nesta planilha; senão
// {templates:[{valor,cadastrado}], uos:[...], perfis:[...]} vindo de
// /listar-templates-perfis — reseta ao trocar de arquivo.
let convcliTemplatesResultado = null;

function convcliValoresDistintos(campo) {
  const vistos = new Set();
  convcliRegistros.forEach((r) => {
    const valor = (r.dados[campo] || "").trim();
    if (valor) vistos.add(valor);
  });
  return Array.from(vistos).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
}

function renderConvcliTemplatesLista(container, itens) {
  container.innerHTML = "";
  itens.forEach(({ valor, cadastrado }) => {
    const li = document.createElement("li");
    if (cadastrado === false) {
      li.classList.add("convvei-templates-faltando");
      li.textContent = `⚠ ${valor}`;
      li.title = "Falta cadastrar na SSX";
    } else if (cadastrado === true) {
      li.textContent = `✓ ${valor}`;
      li.title = "Já cadastrado na SSX";
    } else {
      li.textContent = valor;
    }
    container.appendChild(li);
  });
}

function renderConvcliTemplatesModal() {
  if (convcliTemplatesResultado) {
    renderConvcliTemplatesLista(convcliTemplatesListaTemplates, convcliTemplatesResultado.templates);
    renderConvcliTemplatesLista(convcliTemplatesListaUos, convcliTemplatesResultado.uos);
    renderConvcliTemplatesLista(convcliTemplatesListaPerfis, convcliTemplatesResultado.perfis);
    convcliTemplatesLegenda.textContent = "⚠ em vermelho = falta cadastrar na SSX; ✓ = já cadastrado.";
  } else {
    const templates = convcliValoresDistintos("template_cliente").map((valor) => ({ valor }));
    const uos = convcliValoresDistintos("unidade_organizacional").map((valor) => ({ valor }));
    const perfis = convcliValoresDistintos("perfil_acesso").map((valor) => ({ valor }));
    renderConvcliTemplatesLista(convcliTemplatesListaTemplates, templates);
    renderConvcliTemplatesLista(convcliTemplatesListaUos, uos);
    renderConvcliTemplatesLista(convcliTemplatesListaPerfis, perfis);
    convcliTemplatesLegenda.textContent = 'Valores usados na planilha — clique em "Verificar cadastro na SSX" pra ver o que já está cadastrado.';
  }
}

async function verificarConvcliTemplatesNaSsx() {
  if (!convcliFileId) return;
  const btn = el("btn-convcli-templates-verificar-ssx");
  btn.disabled = true;
  btn.textContent = "Verificando...";
  try {
    const r = await fetch("/api/conversor-clientes/listar-templates-perfis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcliFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (r.status === 401 || r.status === 409) {
        convcliSsxOk = false;
        convcliAtualizarPillAuth();
        convcliLoginAoEntrar = verificarConvcliTemplatesNaSsx;
        renderSelectConvcliCredenciais();
        overlayConvcliLogin.classList.remove("hidden");
        return;
      }
      mostrarErroConvcli(data.error || "Falha ao consultar templates/UO/perfis na SSX.");
      return;
    }
    convcliTemplatesResultado = { templates: data.templates, uos: data.uos, perfis: data.perfis };
    renderConvcliTemplatesModal();
  } catch (err) {
    mostrarErroConvcli(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Verificar cadastro na SSX";
  }
}

el("btn-convcli-templates").addEventListener("click", () => {
  if (!convcliFileId) {
    return mostrarErroConvcli("Carregue e mapeie uma planilha no Conversor de Clientes antes.");
  }
  renderConvcliTemplatesModal();
  overlayConvcliTemplates.classList.remove("hidden");
});

el("btn-convcli-templates-verificar-ssx").addEventListener("click", () => {
  if (!convcliSsxOk) {
    convcliLoginAoEntrar = verificarConvcliTemplatesNaSsx;
    renderSelectConvcliCredenciais();
    overlayConvcliLogin.classList.remove("hidden");
    return;
  }
  verificarConvcliTemplatesNaSsx();
});

el("convcli-templates-fechar").addEventListener("click", () => {
  overlayConvcliTemplates.classList.add("hidden");
});

function baixarConvcliArquivo(modo) {
  const a = document.createElement("a");
  a.href = `/api/conversor-clientes/exportar/${convcliFileId}/${modo}`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Pop-up "tem cliente com erro" — mesmo padrão visual/fluxo do pop-up equivalente
// do conversor KML (.modal-aviso-erro em style.css), com os textos certos pro
// contexto de clientes.
const overlayConvcliBaixarErro = el("overlay-convcli-baixar-erro");
const textoConvcliBaixarErro = el("convcli-baixar-erro-texto");
let resolverConvcliBaixarErro = null;
function fecharConvcliBaixarErro(escolha) {
  overlayConvcliBaixarErro.classList.add("hidden");
  const resolve = resolverConvcliBaixarErro;
  resolverConvcliBaixarErro = null;
  if (resolve) resolve(escolha);
}
function confirmarConvcliBaixarErro(nComErro) {
  const plural = nComErro === 1 ? "cliente não passou" : "clientes não passaram";
  textoConvcliBaixarErro.textContent =
    `${nComErro} ${plural} na validação e podem ser rejeitados pelo SSX na importação. Baixe só os válidos, ou inclua os com erro pra corrigir depois.`;
  overlayConvcliBaixarErro.classList.remove("hidden");
  return new Promise((resolve) => { resolverConvcliBaixarErro = resolve; });
}
el("convcli-baixar-erro-fechar").addEventListener("click", () => fecharConvcliBaixarErro("cancelar"));
el("btn-convcli-baixar-erro-cancelar").addEventListener("click", () => fecharConvcliBaixarErro("cancelar"));
el("btn-convcli-baixar-com-erros").addEventListener("click", () => fecharConvcliBaixarErro("com-erros"));
el("btn-convcli-baixar-sem-erros").addEventListener("click", () => fecharConvcliBaixarErro("sem-erros"));

el("btn-convcli-baixar").addEventListener("click", async () => {
  if (!convcliFileId) return;
  const resultado = await rodarValidacaoConvcli();
  if (!resultado) return;
  if (resultado.n_erro > 0) {
    const escolha = await confirmarConvcliBaixarErro(resultado.n_erro);
    if (escolha === "cancelar") return;
    baixarConvcliArquivo(escolha === "com-erros" ? "todos" : "validos");
  } else {
    baixarConvcliArquivo("todos");
  }
});

// Alternativa ao "Baixar arquivo para importação": abre o mesmo modal de
// importação genérico (upload -> mapear colunas -> progresso) usado em Área
// de Importação e Consulta, já pronto pro tipo "cliente" — não reaproveita o
// arquivo/mapeamento já carregados aqui (planilha de origem e layout costumam
// ser diferentes do CSV da SSX), é um fluxo de importação à parte.
el("btn-convcli-importar-api").addEventListener("click", () => {
  if (!convcliFileId) {
    return mostrarErroConvcli("Carregue e mapeie uma planilha no Conversor de Clientes antes.");
  }
  // Mesma sessão avulsa de "Verificar na SSX" (/api/login grava o mesmo
  // session["token"] dos dois) — não existe uma autenticação "global"
  // separada; se ainda não logou aqui nesta aba, abre o mesmo login, igual
  // o botão "Verificar na SSX" faz.
  if (!convcliSsxOk) {
    convcliLoginAoEntrar = abrirModalImportDeConvcli;
    renderSelectConvcliCredenciais();
    overlayConvcliLogin.classList.remove("hidden");
    return;
  }
  abrirModalImportDeConvcli();
});

// --- CONVERSOR DE VEÍCULOS -> SSX ---
// Sub-tela "/ferramentas/conversor-veiculos": mesmo fluxo e mesmo molde da
// seção "CONVERSOR DE CLIENTES -> SSX" acima (upload -> mapear colunas ->
// ajustar/transformar -> validar -> exportar), rodando no servidor
// (conversor_veiculos.py + validador_importacao/) — só as transformações em
// massa mudam (campos de veículo/rastreador/chip em vez de pessoa/endereço).
const convveiInputArquivo = el("convvei-input-arquivo");
const convveiArquivoNome = el("convvei-arquivo-nome");
const convveiSecaoMapeamento = el("convvei-secao-mapeamento");
const convveiMapaCampos = el("convvei-mapa-campos");
const convveiMapaResumo = el("convvei-mapa-resumo");
const convveiMapaResumoTexto = el("convvei-mapa-resumo-texto");
const convveiMapaDetalhe = el("convvei-mapa-detalhe");
const btnConvveiMapear = el("btn-convvei-mapear");
const convveiSecaoTrabalho = el("convvei-secao-trabalho");
const convveiResumo = el("convvei-resumo");
const convveiTabelaThead = el("convvei-tabela-thead");
const convveiTabelaTbody = el("convvei-tabela-tbody");
const convveiTabelaElemento = convveiTabelaThead.closest("table");
const convveiTamanhoPagina = el("convvei-tamanho-pagina");
const convveiPaginacao = el("convvei-paginacao");
const convveiTabelaArea = el("convvei-tabela-area");
const CONVVEI_LARGURAS_KEY = "larguraColunas_convveiVeiculos";

// Mesmo ajuste de altura do Conversor de Clientes (ver ajustarAlturaConvcliTabelaArea
// acima) — reaproveita o mesmo elConteudoPrincipal/ResizeObserver já criados lá.
function ajustarAlturaConvveiTabelaArea() {
  if (!convveiTabelaArea || !elConteudoPrincipal) return;
  convveiTabelaArea.style.height = `${elConteudoPrincipal.clientHeight - 24}px`;
}
if (elConteudoPrincipal && window.ResizeObserver) {
  new ResizeObserver(ajustarAlturaConvveiTabelaArea).observe(elConteudoPrincipal);
}
window.addEventListener("resize", ajustarAlturaConvveiTabelaArea);

let convveiFileId = null;
let convveiColunasOrigem = [];
let convveiCampos = [];          // definição oficial (chave, rótulo, obrigatório, tipo, tamanho_max)
let convveiCamposMapeados = [];  // subconjunto de convveiCampos que entrou no mapeamento aplicado
let convveiRegistros = [];       // [{indice, original, dados}]
let convveiProblemasPorIndice = {}; // {indice: {erros:[...], avisos:[...]}}, populado por /validar
let convveiDuplicadosPorIndice = {}; // idem, mas populado por /verificar-duplicidade (SSX) — store separado pra um não apagar o outro
let convveiNomeBase = "veiculos";
let convveiPagina = 1;
let convveiOrdenacao = null; // { chave: "indice" | "problema" | <campo.chave>, direcao: 1 | -1 }

// Autenticação na SSX pra "Verificar na SSX" — flag PRÓPRIA desta tela (nunca
// estado.autenticado, de outra tela — ver gotcha nº1 do Conversor de Clientes).
// Começa falsa sempre e volta a falsa ao trocar de arquivo.
let convveiSsxOk = false;
let convveiSsxLogin = "";
let convveiSsxBase = "";
let convveiSsxClaimsRaw = null;

function convveiAtualizarPillAuth() {
  const pill = el("convvei-status-auth");
  const btnLogout = el("btn-convvei-logout-ssx");
  if (convveiSsxOk) {
    pill.textContent = convveiSsxLogin
      ? `Autenticado na SSX (${convveiSsxLogin}${convveiSsxBase ? " — " + convveiSsxBase : ""})`
      : "Autenticado na SSX";
    pill.title = convveiSsxClaimsRaw ? JSON.stringify(convveiSsxClaimsRaw) : "";
    pill.className = "status-pill status-on";
    btnLogout.classList.remove("hidden");
  } else {
    pill.textContent = "Não autenticado na SSX";
    pill.className = "status-pill status-off";
    btnLogout.classList.add("hidden");
  }
}

function limparConvvei() {
  convveiFileId = null;
  convveiColunasOrigem = [];
  convveiCamposMapeados = [];
  convveiRegistros = [];
  convveiProblemasPorIndice = {};
  convveiDuplicadosPorIndice = {};
  convveiSsxOk = false;
  convveiSsxLogin = "";
  convveiSsxBase = "";
  convveiSsxClaimsRaw = null;
  convveiAtualizarPillAuth();
  convveiNomeBase = "veiculos";
  convveiPagina = 1;
  convveiOrdenacao = null;
  convveiInputArquivo.value = "";
  convveiArquivoNome.textContent = "Nenhum arquivo selecionado";
  convveiSecaoMapeamento.classList.add("hidden");
  convveiSecaoTrabalho.classList.add("hidden");
  convveiMapaResumo.classList.add("hidden");
  convveiMapaDetalhe.classList.remove("hidden");
  convveiMapaCampos.innerHTML = "";
  convveiResumo.innerHTML = "";
  convveiTabelaThead.innerHTML = "";
  convveiTabelaTbody.innerHTML = "";
  convveiPaginacao.innerHTML = "";
  btnConvveiMapear.disabled = true;
}
limparConvvei();

// mostrarErro() genérico escreve no painel "Saída", escondido em Ferramentas
// Auxiliares (ver gotcha nº2 do Conversor de Clientes) — por isso função
// própria, que escreve dentro desta sub-tela.
function mostrarErroConvvei(msg) {
  convveiResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  convveiResumo.appendChild(p);
}

function mostrarInfoConvvei(msg) {
  convveiResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = msg;
  convveiResumo.appendChild(p);
}

async function carregarConvveiCampos() {
  if (convveiCampos.length) return convveiCampos;
  const r = await fetch("/api/conversor-veiculos/campos");
  const data = await parseJsonResponse(r);
  if (!data.ok) throw new Error(data.error || "Falha ao carregar os campos da SSX.");
  convveiCampos = data.campos;
  return convveiCampos;
}

// Mapeamento padrão: posicional, pela ordem oficial do manual da SSX — mesma
// regra do Conversor de Clientes (ver renderConvcliMapaCampos).
function renderConvveiMapaCampos() {
  convveiMapaCampos.innerHTML = "";
  convveiCampos.forEach((campo, i) => {
    const linha = document.createElement("div");
    linha.className = "convcli-mapa-linha";

    const nome = document.createElement("span");
    nome.className = "convcli-mapa-nome";
    const marca = campo.obrigatorio === true ? " *" : campo.obrigatorio === "condicional" ? " (condicional)" : "";
    nome.textContent = campo.rotulo + marca;
    nome.title = campo.rotulo + marca;

    const select = document.createElement("select");
    select.dataset.campo = campo.chave;
    const optVazio = document.createElement("option");
    optVazio.value = "";
    optVazio.textContent = "— não mapear —";
    select.appendChild(optVazio);
    convveiColunasOrigem.forEach((col) => {
      const opt = document.createElement("option");
      opt.value = col;
      opt.textContent = col;
      select.appendChild(opt);
    });
    if (convveiColunasOrigem[i] !== undefined) select.value = convveiColunasOrigem[i];

    linha.appendChild(nome);
    linha.appendChild(select);
    convveiMapaCampos.appendChild(linha);
  });
}

el("btn-convvei-mapear-limpar").addEventListener("click", () => {
  convveiMapaCampos.querySelectorAll("select").forEach((sel) => { sel.value = ""; });
});

el("btn-convvei-mapear-auto").addEventListener("click", () => {
  convveiMapaCampos.querySelectorAll("select").forEach((sel, i) => {
    sel.value = convveiColunasOrigem[i] !== undefined ? convveiColunasOrigem[i] : "";
  });
});

el("btn-convvei-mapa-editar").addEventListener("click", () => {
  convveiMapaResumo.classList.add("hidden");
  convveiMapaDetalhe.classList.remove("hidden");
});

convveiInputArquivo.addEventListener("change", async () => {
  const file = convveiInputArquivo.files[0];
  if (!file) return;
  convveiArquivoNome.textContent = "Enviando...";
  convveiSecaoTrabalho.classList.add("hidden");
  convveiSecaoMapeamento.classList.add("hidden");
  convveiSsxOk = false;
  convveiDuplicadosPorIndice = {};
  convveiAtualizarPillAuth();
  resetarConvveiGt06();
  convveiTemplatesResultado = null;
  try {
    await carregarConvveiCampos();
    const formData = new FormData();
    formData.append("arquivo", file);
    const r = await fetch("/api/conversor-veiculos/upload", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      convveiArquivoNome.textContent = "Nenhum arquivo selecionado";
      return mostrarErroConvvei(data.error || "Falha ao enviar arquivo.");
    }
    convveiFileId = data.file_id;
    convveiColunasOrigem = data.colunas;
    convveiNomeBase = file.name.replace(/\.(xlsx|xls|csv)$/i, "");
    convveiArquivoNome.textContent = `${file.name} (${data.total_linhas} linha(s))`;
    renderConvveiMapaCampos();
    convveiSecaoMapeamento.classList.remove("hidden");
    btnConvveiMapear.disabled = false;
  } catch (err) {
    convveiArquivoNome.textContent = "Nenhum arquivo selecionado";
    mostrarErroConvvei(err.message || String(err));
  }
});

btnConvveiMapear.addEventListener("click", async () => {
  const mapping = {};
  convveiMapaCampos.querySelectorAll("select").forEach((sel) => {
    if (sel.value) mapping[sel.dataset.campo] = sel.value;
  });
  if (Object.keys(mapping).length === 0) {
    return mostrarErroConvvei("Mapeie ao menos uma coluna antes de continuar.");
  }
  btnConvveiMapear.disabled = true;
  btnConvveiMapear.textContent = "Aplicando...";
  try {
    const r = await fetch("/api/conversor-veiculos/mapear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convveiFileId, mapping }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvvei(data.error || "Falha ao aplicar o mapeamento.");
    convveiRegistros = data.registros;
    convveiCamposMapeados = convveiCampos.filter((c) => mapping[c.chave]);
    convveiProblemasPorIndice = {};
    convveiDuplicadosPorIndice = {};
    convveiPagina = 1;
    convveiOrdenacao = null;
    convveiSecaoTrabalho.classList.remove("hidden");
    ajustarAlturaConvveiTabelaArea();
    renderConvveiTabelaCabecalho();
    renderConvveiTabela();
    await rodarValidacaoConvvei();

    const n = convveiCamposMapeados.length;
    convveiMapaResumoTexto.textContent = `${n} campo${n === 1 ? "" : "s"} mapeado${n === 1 ? "" : "s"}.`;
    convveiMapaDetalhe.classList.add("hidden");
    convveiMapaResumo.classList.remove("hidden");
  } catch (err) {
    mostrarErroConvvei(err.message || String(err));
  } finally {
    btnConvveiMapear.disabled = false;
    btnConvveiMapear.textContent = "Aplicar mapeamento";
  }
});

function convveiValorColuna(registro, chave) {
  if (chave === "indice") return registro.indice;
  if (chave === "problema") return convveiRegistroTemProblema(registro.indice) ? 1 : 0;
  return registro.dados[chave];
}

function ordenarConvveiRegistros(registros) {
  if (!convveiOrdenacao) return registros;
  const { chave, direcao } = convveiOrdenacao;
  return registros.slice().sort((a, b) => {
    const va = valorOrdenavel(convveiValorColuna(a, chave));
    const vb = valorOrdenavel(convveiValorColuna(b, chave));
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * direcao;
    return String(va).localeCompare(String(vb), "pt-BR", { numeric: true, sensitivity: "base" }) * direcao;
  });
}

function renderConvveiTabelaCabecalho() {
  convveiTabelaThead.innerHTML = "";
  const tr = document.createElement("tr");

  const criarThOrdenavel = (texto, chave, larguraPadrao) => {
    const th = document.createElement("th");
    th.className = "th-ordenavel";
    th.style.width = `${larguraPadrao}px`;
    th.textContent = texto;
    if (convveiOrdenacao && convveiOrdenacao.chave === chave) {
      const seta = document.createElement("span");
      seta.className = "seta-ordenacao";
      seta.textContent = convveiOrdenacao.direcao === 1 ? " ▲" : " ▼";
      th.appendChild(seta);
    }
    th.addEventListener("click", () => {
      const direcao = convveiOrdenacao && convveiOrdenacao.chave === chave ? -convveiOrdenacao.direcao : 1;
      convveiOrdenacao = { chave, direcao };
      convveiPagina = 1;
      renderConvveiTabelaCabecalho();
      renderConvveiTabela();
    });
    return th;
  };

  // "Linha" e "Problema" — colunas próprias (separadas do "#" único de
  // antes), só com ordenação (sem filtro) — congeladas com largura fixa
  // (ver larguraFixaPorIndice em tornarColunasRedimensionaveis, chamada em
  // renderConvveiTabela): fixa porque o CSS trava o "left" da 2ª coluna num
  // valor fixo (52px, a largura exata da 1ª), não dava pra deixar
  // redimensionável sem recalcular esse offset a cada arrasto.
  const thLinha = criarThOrdenavel("Linha", "indice", 52);
  thLinha.classList.add("convvei-th-linha");
  tr.appendChild(thLinha);
  const thProblema = criarThOrdenavel("Prob.", "problema", 40);
  thProblema.classList.add("convvei-th-problema");
  tr.appendChild(thProblema);

  convveiCamposMapeados.forEach((campo) => tr.appendChild(criarThOrdenavel(campo.rotulo, campo.chave, 180)));

  const thAcoes = document.createElement("th");
  thAcoes.style.width = "46px";
  thAcoes.textContent = "";
  tr.appendChild(thAcoes);

  convveiTabelaThead.appendChild(tr);
}

function convveiTotalPaginas() {
  return Math.max(1, Math.ceil(convveiRegistros.length / Number(convveiTamanhoPagina.value)));
}

function convveiProblemaCombinado(indice) {
  const a = convveiProblemasPorIndice[indice];
  const b = convveiDuplicadosPorIndice[indice];
  if (!a && !b) return null;
  return {
    erros: [...(a ? a.erros : []), ...(b ? b.erros : [])],
    avisos: [...(a ? a.avisos : []), ...(b ? b.avisos : [])],
  };
}

function convveiRegistroTemProblema(indice) {
  const p = convveiProblemaCombinado(indice);
  return !!(p && (p.erros.length > 0 || p.avisos.length > 0));
}

function montarLinhaConvvei(registro) {
  const tr = document.createElement("tr");
  tr.dataset.indice = registro.indice;
  const problema = convveiProblemaCombinado(registro.indice);

  // "Linha" e "Problema" — colunas separadas (antes era um "#" só, com
  // ícone + número juntos no mesmo texto).
  const tdLinha = document.createElement("td");
  tdLinha.className = "convvei-td-linha";
  tdLinha.textContent = String(registro.indice);
  tr.appendChild(tdLinha);

  const tdProblema = document.createElement("td");
  tdProblema.className = "convvei-td-problema";
  let icone = "";
  if (problema && problema.erros.length > 0) {
    icone = "🔴";
    tr.classList.add("conversor-edicao-linha-erro");
  } else if (problema && problema.avisos.length > 0) {
    icone = "⚠️";
  } else if (problema) {
    icone = "✓";
  }
  tdProblema.textContent = icone;
  if (problema) {
    const msgs = [...problema.erros.map((e) => `⛔ ${e.mensagem}`), ...problema.avisos.map((a) => `⚠️ ${a.mensagem}`)];
    tr.title = msgs.join("\n");
    tdProblema.title = tr.title;
  }
  tr.appendChild(tdProblema);

  // "duplicado_ssx" (vermelho) e "nao_cadastrado_ssx" (vermelho também —
  // referência que deveria existir na SSX e não existe, mesma gravidade de
  // uma duplicata real) vêm de "Verificar na SSX"; "duplicado_planilha"
  // (amarelo) é só dentro da própria planilha, sempre local/automático.
  const duplicadosPorCampo = {};
  if (problema) {
    const todos = [...problema.erros, ...problema.avisos];
    todos.filter((p) => p.categoria === "duplicado_planilha").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
    todos.filter((p) => p.categoria === "duplicado_ssx" || p.categoria === "nao_cadastrado_ssx").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
  }

  convveiCamposMapeados.forEach((campo) => {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.value = registro.dados[campo.chave] || "";
    const duplicado = duplicadosPorCampo[campo.rotulo];
    if (duplicado) {
      input.classList.add((duplicado.categoria === "duplicado_ssx" || duplicado.categoria === "nao_cadastrado_ssx") ? "convcli-campo-duplicado" : "convcli-campo-duplicado-planilha");
      input.title = duplicado.mensagem;
    }
    input.addEventListener("change", async () => {
      registro.dados[campo.chave] = input.value;
      try {
        const r = await fetch("/api/conversor-veiculos/editar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: convveiFileId, indice: registro.indice, campo: campo.chave, valor: input.value }),
        });
        const data = await parseJsonResponse(r);
        if (!data.ok) return mostrarErroConvvei(data.error || "Falha ao salvar a edição.");
        await rodarValidacaoConvvei();
      } catch (err) {
        mostrarErroConvvei(err.message || String(err));
      }
    });
    td.appendChild(input);
    tr.appendChild(td);
  });

  const tdAcoes = document.createElement("td");
  tdAcoes.className = "convcli-td-acoes";
  const btnExcluir = document.createElement("button");
  btnExcluir.type = "button";
  btnExcluir.className = "btn-secondary convcli-btn-excluir-linha";
  btnExcluir.textContent = "🗑️";
  btnExcluir.title = "Excluir esta linha";
  btnExcluir.addEventListener("click", () => excluirLinhaConvvei(registro.indice));
  tdAcoes.appendChild(btnExcluir);
  tr.appendChild(tdAcoes);

  return tr;
}

function renderConvveiTabela() {
  const tamanho = Number(convveiTamanhoPagina.value);
  const registrosOrdenados = ordenarConvveiRegistros(convveiRegistros);
  convveiPagina = Math.min(Math.max(1, convveiPagina), convveiTotalPaginas());
  const inicio = (convveiPagina - 1) * tamanho;
  convveiTabelaTbody.innerHTML = "";
  registrosOrdenados.slice(inicio, inicio + tamanho).forEach((r) => convveiTabelaTbody.appendChild(montarLinhaConvvei(r)));
  // "Linha"/"Problema" ficam de fora do redimensionamento (ver
  // larguraFixaPorIndice) — largura sempre fixa (52px/40px), pra bater com o
  // "left" fixo das duas colunas congeladas no CSS (.convvei-td-problema).
  tornarColunasRedimensionaveis(convveiTabelaElemento, CONVVEI_LARGURAS_KEY, { 0: 52, 1: 40 });
  atualizarConvveiGt06Lista();

  convveiPaginacao.innerHTML = "";
  const total = convveiTotalPaginas();
  if (total > 1) {
    const anterior = document.createElement("button");
    anterior.type = "button";
    anterior.className = "btn-secondary";
    anterior.textContent = "‹ Anterior";
    anterior.disabled = convveiPagina === 1;
    anterior.addEventListener("click", () => { convveiPagina--; renderConvveiTabela(); });
    const info = document.createElement("span");
    info.textContent = `Página ${convveiPagina} de ${total}`;
    const proxima = document.createElement("button");
    proxima.type = "button";
    proxima.className = "btn-secondary";
    proxima.textContent = "Próxima ›";
    proxima.disabled = convveiPagina === total;
    proxima.addEventListener("click", () => { convveiPagina++; renderConvveiTabela(); });
    [anterior, info, proxima].forEach((n) => convveiPaginacao.appendChild(n));
  }
}
convveiTamanhoPagina.addEventListener("change", () => { convveiPagina = 1; renderConvveiTabela(); });

// --- EXCLUIR / ADICIONAR LINHA (Conversor de Veículos) ---
async function excluirLinhaConvvei(indice) {
  if (!convveiFileId) return;
  if (!confirm(`Excluir a linha ${indice}? Essa ação não pode ser desfeita.`)) return;
  try {
    const r = await fetch("/api/conversor-veiculos/excluir-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convveiFileId, indice }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvvei(data.error || "Falha ao excluir a linha.");
    convveiRegistros = convveiRegistros.filter((r2) => r2.indice !== indice);
    delete convveiDuplicadosPorIndice[indice];
    await rodarValidacaoConvvei();
    mostrarInfoConvvei(`Linha ${indice} excluída.`);
  } catch (err) {
    mostrarErroConvvei(err.message || String(err));
  }
}

el("btn-convvei-adicionar-linha").addEventListener("click", async () => {
  if (!convveiFileId) return;
  try {
    const r = await fetch("/api/conversor-veiculos/adicionar-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convveiFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvvei(data.error || "Falha ao adicionar a linha.");
    convveiRegistros.push(data.registro);
    convveiOrdenacao = null;
    renderConvveiTabelaCabecalho();
    convveiPagina = convveiTotalPaginas();
    await rodarValidacaoConvvei();
    mostrarInfoConvvei(`Linha ${data.registro.indice} adicionada — preencha os campos.`);
  } catch (err) {
    mostrarErroConvvei(err.message || String(err));
  }
});

el("btn-convvei-limpar-vazias").addEventListener("click", async () => {
  if (!convveiFileId) return;
  try {
    const r = await fetch("/api/conversor-veiculos/limpar-vazias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convveiFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvvei(data.error || "Falha ao limpar as linhas vazias.");
    convveiRegistros = convveiRegistros.filter((reg) => Object.values(reg.dados).some((v) => (v || "").trim()));
    convveiPagina = 1;
    await rodarValidacaoConvvei();
    mostrarInfoConvvei(data.removidos ? `${data.removidos} linha(s) vazia(s) removida(s).` : "Nenhuma linha vazia encontrada.");
  } catch (err) {
    mostrarErroConvvei(err.message || String(err));
  }
});

// Transformações em massa: roda no servidor sobre TODAS as linhas mapeadas e
// devolve só os registros que mudaram — mesmo padrão de
// rodarTransformacaoConvcli (Conversor de Clientes).
async function rodarTransformacaoConvvei(acao, params, montarMensagem) {
  if (!convveiFileId) return;
  try {
    const r = await fetch("/api/conversor-veiculos/transformar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convveiFileId, acao, params: params || {} }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvvei(data.error || "Falha ao aplicar a transformação.");
    const porIndice = new Map(data.registros.map((r2) => [r2.indice, r2]));
    convveiRegistros = convveiRegistros.map((r2) => porIndice.get(r2.indice) || r2);
    await rodarValidacaoConvvei();
    mostrarInfoConvvei(montarMensagem ? montarMensagem(data) : `${data.total_alterados} registro(s) alterado(s).`);
  } catch (err) {
    mostrarErroConvvei(err.message || String(err));
  }
}

el("btn-convvei-limpar-placa").addEventListener("click", () =>
  rodarTransformacaoConvvei("limpar_campo", { campo: "placa" }, (data) => `${data.ajustados} placa(s) limpa(s).`));
el("btn-convvei-ajustar-chips").addEventListener("click", () => {
  const dddPadrao = el("convvei-ddd-padrao").value.trim() || "55";
  rodarTransformacaoConvvei("ajustar_chips", { ddd_padrao: dddPadrao }, (data) =>
    `${data.linhas_ajustadas} linha(s) com DDI/DDD de chip ajustado(s).`);
});

// "Padrão GT06": a lista de templates distintos de Rastreador 1 usados na
// planilha (considerando TODAS as linhas, não só a página visível — vem de
// convveiRegistros, já carregado inteiro em memória) aparece sozinha, sem
// precisar de um botão "identificar" — atualizarConvveiGt06Lista() é
// chamada a cada renderConvveiTabela() (ou seja, a cada upload/mapeamento/
// transformação/edição/validação). Só mexe no DOM quando a lista de
// templates realmente muda, pra não perder o que já estava marcado nem o
// foco só por causa de troca de página.
const convveiGt06Vazio = el("convvei-gt06-vazio");
const convveiGt06Lista = el("convvei-gt06-lista");
const convveiGt06AplicarWrap = el("convvei-gt06-aplicar-wrap");
let convveiGt06UltimaListaTemplates = null; // string[] da última renderização
let convveiGt06Marcados = new Set(); // nomes marcados — sobrevive a reconstruções da lista

function resetarConvveiGt06() {
  convveiGt06UltimaListaTemplates = null;
  convveiGt06Marcados = new Set();
  convveiGt06Lista.innerHTML = "";
  convveiGt06Lista.classList.add("hidden");
  convveiGt06AplicarWrap.classList.add("hidden");
  convveiGt06Vazio.classList.remove("hidden");
}

function convveiTemplatesDistintosRastreador1() {
  const vistos = new Set();
  convveiRegistros.forEach((r) => {
    const valor = (r.dados.rastreador1_template || "").trim();
    if (valor) vistos.add(valor);
  });
  return Array.from(vistos).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
}

function atualizarConvveiGt06Lista() {
  const templates = convveiTemplatesDistintosRastreador1();
  const mudou = !convveiGt06UltimaListaTemplates
    || templates.length !== convveiGt06UltimaListaTemplates.length
    || templates.some((t, i) => t !== convveiGt06UltimaListaTemplates[i]);
  if (!mudou) return;
  convveiGt06UltimaListaTemplates = templates;
  convveiGt06Marcados = new Set([...convveiGt06Marcados].filter((t) => templates.includes(t)));

  convveiGt06Lista.innerHTML = "";
  if (templates.length === 0) {
    convveiGt06Lista.classList.add("hidden");
    convveiGt06AplicarWrap.classList.add("hidden");
    convveiGt06Vazio.classList.remove("hidden");
    return;
  }
  templates.forEach((t, i) => {
    const label = document.createElement("label");
    label.className = "convcli-checkbox-inline";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = t;
    input.id = `convvei-gt06-template-${i}`;
    input.checked = convveiGt06Marcados.has(t);
    input.addEventListener("change", () => {
      if (input.checked) convveiGt06Marcados.add(t);
      else convveiGt06Marcados.delete(t);
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(t));
    convveiGt06Lista.appendChild(label);
  });
  convveiGt06Vazio.classList.add("hidden");
  convveiGt06Lista.classList.remove("hidden");
  convveiGt06AplicarWrap.classList.remove("hidden");
}

function convveiGt06Selecionados() {
  return Array.from(convveiGt06Marcados);
}

el("btn-convvei-gt06-aplicar").addEventListener("click", () => {
  const selecionados = convveiGt06Selecionados();
  if (selecionados.length === 0) {
    return mostrarErroConvvei("Selecione ao menos um template antes de aplicar o padrão GT06.");
  }
  rodarTransformacaoConvvei("aplicar_gt06", { templates: selecionados }, (data) =>
    `${data.ajustados} identificação(ões) e ${data.ajustados_codigo_integracao} código(s) de integração de Rastreador 1 ajustado(s) (zero inicial) para o(s) template(s): ${selecionados.join(", ")}.`);
});

// "Limpar padrão GT06": remove só o 1º zero do início da identificação E do
// código de integração — oposto de "Aplicar padrão GT06". Sem nenhum
// template marcado, vale pra TODOS os templates da lista (ver
// conversor_veiculos.limpar_padrao_gt06), mas só depois de confirmar —
// ação mais ampla, risco maior de engano.
el("btn-convvei-gt06-limpar").addEventListener("click", () => {
  const selecionados = convveiGt06Selecionados();
  if (selecionados.length === 0) {
    const confirmado = confirm(
      "Nenhum template selecionado. Isso vai remover o zero inicial da identificação e do código de integração de TODOS os templates da lista. Confirma?"
    );
    if (!confirmado) return;
  }
  rodarTransformacaoConvvei("limpar_gt06", { templates: selecionados }, (data) =>
    `${data.ajustados} identificação(ões) e ${data.ajustados_codigo_integracao} código(s) de integração de Rastreador 1 com o zero inicial removido`
    + (selecionados.length ? ` para o(s) template(s): ${selecionados.join(", ")}.` : " (todos os templates)."));
});

el("btn-convvei-repetir-codigo-veiculo-cliente").addEventListener("click", () => {
  rodarTransformacaoConvvei(
    "repetir_campo", { origem: "codigo_integracao_veiculo", destino: "veiculo_cliente" },
    (data) => `${data.repetidos} código(s) de veículo repetido(s) em Código de integração do veículo do cliente.`
  );
});
el("btn-convvei-repetir-placa-identificacao").addEventListener("click", () => {
  rodarTransformacaoConvvei("repetir_campo", { origem: "placa", destino: "identificacao" }, (data) =>
    `${data.repetidos} placa(s) repetida(s) em Identificação.`);
});
el("btn-convvei-repetir-placa-codigo-veiculo").addEventListener("click", () => {
  rodarTransformacaoConvvei("repetir_campo", { origem: "placa", destino: "codigo_integracao_veiculo" }, (data) =>
    `${data.repetidos} placa(s) repetida(s) em Código de integração do veículo.`);
});
el("btn-convvei-repetir-rastreador1-codigo").addEventListener("click", () => {
  rodarTransformacaoConvvei(
    "repetir_campo", { origem: "rastreador1_identificacao", destino: "rastreador1_codigo_integracao" },
    (data) => `${data.repetidos} identificação(ões) repetida(s) em Código de integração (Rastreador 1).`
  );
});

// "Preencher pra todas as linhas" — um único handler genérico (acao
// "preencher_campo", igual o backend espera), reaproveitado pelos botões
// de ícone/cor do mapa em vez de repetir a mesma lógica duas vezes.
function ligarBtnConvveiPreencherTodas(idBotao, idInput, campo, rotuloErro) {
  el(idBotao).addEventListener("click", () => {
    const valor = el(idInput).value.trim();
    if (!valor) return mostrarErroConvvei(`Informe ${rotuloErro} a ser preenchido.`);
    rodarTransformacaoConvvei("preencher_campo", { campo, valor }, (data) =>
      `${data.preenchidos} linha(s) preenchida(s) com "${valor}".`);
  });
}
ligarBtnConvveiPreencherTodas("btn-convvei-preencher-icone", "convvei-icone-mapa-valor", "icone_mapa", "o ícone do mapa");

// Cor do ícone do mapa: escala de cores (CORES_SSX, já usada pelo Conversor
// KML — mesma tabela "Cores de Ícones do Mapa" do manual) em vez de pedir
// pra digitar o número de cor de cabeça — mesmo componente visual
// (".conversor-cor-mini-grupo"/".conversor-cor-mini") usado na edição manual
// do Conversor KML, só que aqui pra escolher UM valor que vale pra toda a
// planilha ao clicar "Preencher todas" (não por linha).
let convveiCorIconeMapaSelecionada = null;
const convveiCorIconeMapaSwatches = el("convvei-cor-icone-mapa-swatches");

function renderConvveiCorIconeMapaSwatches() {
  convveiCorIconeMapaSwatches.innerHTML = "";
  CORES_SSX.forEach(({ codigo, hex }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "conversor-cor-mini";
    btn.style.background = hex;
    btn.title = `Código ${codigo} (${hex})`;
    btn.textContent = String(codigo);
    if (convveiCorIconeMapaSelecionada === codigo) btn.classList.add("selecionada");
    btn.addEventListener("click", () => {
      convveiCorIconeMapaSelecionada = convveiCorIconeMapaSelecionada === codigo ? null : codigo;
      renderConvveiCorIconeMapaSwatches();
    });
    convveiCorIconeMapaSwatches.appendChild(btn);
  });
}
renderConvveiCorIconeMapaSwatches();

el("btn-convvei-preencher-cor-icone").addEventListener("click", () => {
  if (!convveiCorIconeMapaSelecionada) return mostrarErroConvvei("Selecione uma cor na escala antes de preencher.");
  const valor = String(convveiCorIconeMapaSelecionada);
  rodarTransformacaoConvvei("preencher_campo", { campo: "cor_icone_mapa", valor }, (data) =>
    `${data.preenchidos} linha(s) preenchida(s) com a cor ${valor}.`);
});

// Preenchimento em massa dos 4 status do mapa — só os campos marcados nos
// checkboxes são preenchidos (com "1"), os demais ficam intocados. Se
// nenhum estiver marcado, orienta a selecionar ao menos um em vez de
// mandar a requisição (o backend também recusa, mas aqui evita a ida e
// volta e dá a mensagem na hora).
const CONVVEI_CAMPOS_STATUS_MAPA = [
  { id: "convvei-status-ignicao", campo: "exibir_status_ignicao", rotulo: "Exibir status ignição" },
  { id: "convvei-status-operacional", campo: "exibir_status_operacional", rotulo: "Exibir status operacional" },
  { id: "convvei-status-gps", campo: "exibir_status_gps", rotulo: "Exibir status GPS" },
  { id: "convvei-status-violacao", campo: "exibir_status_violacao", rotulo: "Exibir status violação" },
];
el("btn-convvei-preencher-status").addEventListener("click", () => {
  // Os 4 campos são sempre preenchidos: marcado -> 1, não marcado -> 0 (ver
  // conversor_veiculos.preencher_status_mapa) — inclusive sem nenhum
  // checkbox marcado, que preenche os 4 com "0" em vez de bloquear.
  const marcados = CONVVEI_CAMPOS_STATUS_MAPA.filter((s) => el(s.id).checked);
  rodarTransformacaoConvvei("preencher_status", { campos: marcados.map((s) => s.campo) }, (data) =>
    CONVVEI_CAMPOS_STATUS_MAPA.map((s) => {
      const marcado = marcados.some((m) => m.campo === s.campo);
      return `${s.rotulo} = ${marcado ? "1" : "0"} (${data.preenchidos_por_campo[s.campo]} linha(s))`;
    }).join("; ") + ".");
});

function renderConvveiResumo(data) {
  convveiResumo.innerHTML = "";
  const tiles = document.createElement("div");
  tiles.className = "dashboard-tiles";
  [
    { valor: data.n_ok, label: "Válidos" },
    { valor: data.n_erro, label: "Com erro", clicavel: data.n_erro > 0 },
  ].forEach(({ valor, label, clicavel }) => {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const l = document.createElement("div");
    l.className = "stat-tile-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "stat-tile-valor";
    v.textContent = valor;
    tile.appendChild(l);
    tile.appendChild(v);
    if (clicavel) {
      tile.classList.add("stat-tile-clicavel");
      tile.title = "Ir para o primeiro registro com erro";
      tile.addEventListener("click", irParaPrimeiroErroConvvei);
    }
    tiles.appendChild(tile);
  });
  convveiResumo.appendChild(tiles);
  const legenda = document.createElement("p");
  legenda.className = "placeholder";
  legenda.textContent = `${data.n_ok} de ${data.total} registro(s) válidos para importar.`;
  convveiResumo.appendChild(legenda);
}

function irParaPrimeiroErroConvvei() {
  const ordenados = ordenarConvveiRegistros(convveiRegistros);
  const posicao = ordenados.findIndex((r) => {
    const p = convveiProblemaCombinado(r.indice);
    return p && p.erros.length > 0;
  });
  if (posicao === -1) return;

  const tamanho = Number(convveiTamanhoPagina.value);
  convveiPagina = Math.floor(posicao / tamanho) + 1;
  renderConvveiTabela();

  const indice = ordenados[posicao].indice;
  const tr = convveiTabelaTbody.querySelector(`tr[data-indice="${indice}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: "smooth", block: "center" });
  tr.classList.add("convcli-linha-destacada");
  setTimeout(() => tr.classList.remove("convcli-linha-destacada"), 2200);
}

async function rodarValidacaoConvvei() {
  if (!convveiFileId) return null;
  try {
    const r = await fetch("/api/conversor-veiculos/validar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convveiFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvvei(data.error || "Falha ao validar.");
      return null;
    }
    convveiProblemasPorIndice = {};
    data.problemas.forEach((p) => { convveiProblemasPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvveiResumo(data);
    renderConvveiTabela();
    return data;
  } catch (err) {
    mostrarErroConvvei(err.message || String(err));
    return null;
  }
}
el("btn-convvei-validar").addEventListener("click", () => rodarValidacaoConvvei());

// --- VERIFICAR DUPLICIDADE NA SSX (Conversor de Veículos, opcional) ---
const overlayConvveiLogin = el("overlay-convvei-login");
const selectConvveiCredencial = el("convvei-select-credencial");

function renderSelectConvveiCredenciais() {
  selectConvveiCredencial.innerHTML = '<option value="">Login salvo...</option>';
  credenciaisCache.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.nome;
    selectConvveiCredencial.appendChild(opt);
  });
}

selectConvveiCredencial.addEventListener("change", () => {
  const cred = credenciaisCache.find((c) => c.id === selectConvveiCredencial.value);
  if (!cred) return;
  el("convvei-login").value = cred.login;
  el("convvei-senha").value = cred.senha;
  selectConvveiCredencial.value = "";
});

// Callback setado antes de abrir o login, executado 1x depois de autenticar
// e resetado pra null em todo caminho que fecha/reabre o modal — mesmo
// padrão de convcliLoginAoEntrar (ver gotcha nº3 do Conversor de Clientes).
let convveiLoginAoEntrar = null;

el("convvei-login-fechar").addEventListener("click", () => {
  convveiLoginAoEntrar = null;
  overlayConvveiLogin.classList.add("hidden");
});

el("form-convvei-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const login = el("convvei-login").value.trim();
  const senha = el("convvei-senha").value;
  if (!login || !senha) return;
  const btn = el("btn-convvei-autenticar");
  btn.disabled = true;
  btn.textContent = "Entrando...";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, senha }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvvei(data.error || "Falha ao autenticar na SSX.");
      return;
    }
    convveiSsxOk = true;
    convveiSsxLogin = login;
    convveiSsxBase = extrairNomeBaseDeClaims(data.claims);
    convveiSsxClaimsRaw = data.claims || null;
    convveiAtualizarPillAuth();
    overlayConvveiLogin.classList.add("hidden");
    el("convvei-senha").value = "";
    const aoEntrar = convveiLoginAoEntrar;
    convveiLoginAoEntrar = null;
    if (aoEntrar) return await aoEntrar();
    await rodarVerificacaoDuplicidadeConvvei();
  } catch (err) {
    mostrarErroConvvei(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
});

el("btn-convvei-logout-ssx").addEventListener("click", async () => {
  await fetch("/api/logout-avulso", { method: "POST" });
  convveiSsxOk = false;
  convveiSsxLogin = "";
  convveiSsxBase = "";
  convveiSsxClaimsRaw = null;
  convveiAtualizarPillAuth();
  convveiDuplicadosPorIndice = {};
  renderConvveiTabela();
  mostrarInfoConvvei("Sessão da SSX encerrada.");
});

async function rodarVerificacaoDuplicidadeConvvei() {
  if (!convveiFileId) return null;
  const btn = el("btn-convvei-verificar-ssx");
  btn.disabled = true;
  btn.textContent = "Verificando...";
  try {
    const r = await fetch("/api/conversor-veiculos/verificar-duplicidade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convveiFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (r.status === 401 || r.status === 409) {
        convveiSsxOk = false;
        convveiAtualizarPillAuth();
        renderSelectConvveiCredenciais();
        overlayConvveiLogin.classList.remove("hidden");
        return null;
      }
      mostrarErroConvvei(data.error || "Falha ao verificar duplicidade na SSX.");
      return null;
    }
    convveiDuplicadosPorIndice = {};
    data.problemas.forEach((p) => { convveiDuplicadosPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvveiTabela();
    // Mistura duas checagens (ver conversor_veiculos.verificar_duplicidade_ssx
    // e verificar_referencias_ssx) — a mensagem fica genérica de propósito,
    // os detalhes (qual campo, duplicata ou referência não cadastrada)
    // aparecem no hover da célula/linha marcada.
    mostrarInfoConvvei(
      data.total_duplicados
        ? `${data.total_duplicados} de ${data.total_verificados} registro(s) com possível problema na SSX (duplicata ou referência — cliente, template, APN, responsável — não cadastrada).`
        : `Nenhum problema encontrado entre os ${data.total_verificados} registro(s) verificados (duplicata e referências na SSX).`
    );
    return data;
  } catch (err) {
    mostrarErroConvvei(err.message || String(err));
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = "Verificar na SSX";
  }
}

el("btn-convvei-verificar-ssx").addEventListener("click", () => {
  if (!convveiFileId) return;
  if (!convveiSsxOk) {
    convveiLoginAoEntrar = null;
    renderSelectConvveiCredenciais();
    overlayConvveiLogin.classList.remove("hidden");
    return;
  }
  rodarVerificacaoDuplicidadeConvvei();
});

// Botão "Templates": lista os Templates de rastreador e APNs usados na
// planilha inteira — aparece SEMPRE, direto de convveiRegistros (já em
// memória), sem exigir login. A cor vermelha (⚠ "falta cadastrar") é um
// passo à parte e opcional ("Verificar cadastro na SSX" dentro do modal),
// que só então pede autenticação — mesma sessão/login de "Verificar na
// SSX" (convveiSsxOk/convveiLoginAoEntrar).
const overlayConvveiTemplates = el("overlay-convvei-templates");
const convveiTemplatesListaTemplates = el("convvei-templates-lista-templates");
const convveiTemplatesListaApns = el("convvei-templates-lista-apns");
const convveiTemplatesLegenda = el("convvei-templates-legenda");
// null = ainda não verificado na SSX nesta planilha; senão {templates:[{valor,cadastrado}], apns:[...]}
// vindo de /listar-templates-apns — reseta ao trocar de arquivo (ver convveiInputArquivo "change").
let convveiTemplatesResultado = null;

function convveiValoresDistintos(campos) {
  const vistos = new Set();
  convveiRegistros.forEach((r) => {
    campos.forEach((chave) => {
      const valor = (r.dados[chave] || "").trim();
      if (valor) vistos.add(valor);
    });
  });
  return Array.from(vistos).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
}

function renderConvveiTemplatesLista(container, itens) {
  container.innerHTML = "";
  itens.forEach(({ valor, cadastrado }) => {
    const li = document.createElement("li");
    if (cadastrado === false) {
      li.classList.add("convvei-templates-faltando");
      li.textContent = `⚠ ${valor}`;
      li.title = "Falta cadastrar na SSX";
    } else if (cadastrado === true) {
      li.textContent = `✓ ${valor}`;
      li.title = "Já cadastrado na SSX";
    } else {
      li.textContent = valor;
    }
    container.appendChild(li);
  });
}

function renderConvveiTemplatesModal() {
  if (convveiTemplatesResultado) {
    renderConvveiTemplatesLista(convveiTemplatesListaTemplates, convveiTemplatesResultado.templates);
    renderConvveiTemplatesLista(convveiTemplatesListaApns, convveiTemplatesResultado.apns);
    convveiTemplatesLegenda.textContent = "⚠ em vermelho = falta cadastrar na SSX; ✓ = já cadastrado.";
  } else {
    const templates = convveiValoresDistintos(["rastreador1_template", "rastreador2_template"]).map((valor) => ({ valor }));
    const apns = convveiValoresDistintos(["rastreador1_apn1", "rastreador1_apn2", "rastreador2_apn1", "rastreador2_apn2"]).map((valor) => ({ valor }));
    renderConvveiTemplatesLista(convveiTemplatesListaTemplates, templates);
    renderConvveiTemplatesLista(convveiTemplatesListaApns, apns);
    convveiTemplatesLegenda.textContent = 'Valores usados na planilha — clique em "Verificar cadastro na SSX" pra ver o que já está cadastrado.';
  }
}

async function verificarConvveiTemplatesNaSsx() {
  if (!convveiFileId) return;
  const btn = el("btn-convvei-templates-verificar-ssx");
  btn.disabled = true;
  btn.textContent = "Verificando...";
  try {
    const r = await fetch("/api/conversor-veiculos/listar-templates-apns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convveiFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (r.status === 401 || r.status === 409) {
        convveiSsxOk = false;
        convveiAtualizarPillAuth();
        convveiLoginAoEntrar = verificarConvveiTemplatesNaSsx;
        renderSelectConvveiCredenciais();
        overlayConvveiLogin.classList.remove("hidden");
        return;
      }
      mostrarErroConvvei(data.error || "Falha ao consultar templates/APNs na SSX.");
      return;
    }
    convveiTemplatesResultado = { templates: data.templates, apns: data.apns };
    renderConvveiTemplatesModal();
  } catch (err) {
    mostrarErroConvvei(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Verificar cadastro na SSX";
  }
}

el("btn-convvei-templates").addEventListener("click", () => {
  if (!convveiFileId) {
    return mostrarErroConvvei("Carregue e mapeie uma planilha no Conversor de Veículos antes.");
  }
  renderConvveiTemplatesModal();
  overlayConvveiTemplates.classList.remove("hidden");
});

el("btn-convvei-templates-verificar-ssx").addEventListener("click", () => {
  if (!convveiSsxOk) {
    convveiLoginAoEntrar = verificarConvveiTemplatesNaSsx;
    renderSelectConvveiCredenciais();
    overlayConvveiLogin.classList.remove("hidden");
    return;
  }
  verificarConvveiTemplatesNaSsx();
});

el("convvei-templates-fechar").addEventListener("click", () => {
  overlayConvveiTemplates.classList.add("hidden");
});

function baixarConvveiArquivo(modo) {
  const a = document.createElement("a");
  a.href = `/api/conversor-veiculos/exportar/${convveiFileId}/${modo}`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const overlayConvveiBaixarErro = el("overlay-convvei-baixar-erro");
const textoConvveiBaixarErro = el("convvei-baixar-erro-texto");
let resolverConvveiBaixarErro = null;
function fecharConvveiBaixarErro(escolha) {
  overlayConvveiBaixarErro.classList.add("hidden");
  const resolve = resolverConvveiBaixarErro;
  resolverConvveiBaixarErro = null;
  if (resolve) resolve(escolha);
}
function confirmarConvveiBaixarErro(nComErro) {
  const plural = nComErro === 1 ? "veículo não passou" : "veículos não passaram";
  textoConvveiBaixarErro.textContent =
    `${nComErro} ${plural} na validação e podem ser rejeitados pelo SSX na importação. Baixe só os válidos, ou inclua os com erro pra corrigir depois.`;
  overlayConvveiBaixarErro.classList.remove("hidden");
  return new Promise((resolve) => { resolverConvveiBaixarErro = resolve; });
}
el("convvei-baixar-erro-fechar").addEventListener("click", () => fecharConvveiBaixarErro("cancelar"));
el("btn-convvei-baixar-erro-cancelar").addEventListener("click", () => fecharConvveiBaixarErro("cancelar"));
el("btn-convvei-baixar-com-erros").addEventListener("click", () => fecharConvveiBaixarErro("com-erros"));
el("btn-convvei-baixar-sem-erros").addEventListener("click", () => fecharConvveiBaixarErro("sem-erros"));

el("btn-convvei-baixar").addEventListener("click", async () => {
  if (!convveiFileId) return;
  const resultado = await rodarValidacaoConvvei();
  if (!resultado) return;
  if (resultado.n_erro > 0) {
    const escolha = await confirmarConvveiBaixarErro(resultado.n_erro);
    if (escolha === "cancelar") return;
    baixarConvveiArquivo(escolha === "com-erros" ? "todos" : "validos");
  } else {
    baixarConvveiArquivo("todos");
  }
});

el("btn-convvei-importar-api").addEventListener("click", () => {
  if (!convveiFileId) {
    return mostrarErroConvvei("Carregue e mapeie uma planilha no Conversor de Veículos antes.");
  }
  if (!convveiSsxOk) {
    convveiLoginAoEntrar = abrirModalImportDeConvvei;
    renderSelectConvveiCredenciais();
    overlayConvveiLogin.classList.remove("hidden");
    return;
  }
  abrirModalImportDeConvvei();
});

// --- CONVERSOR DE RASTREADORES -> SSX ---
// Sub-tela "/ferramentas/conversor-rastreadores": mesmo fluxo e mesmo molde
// da seção "CONVERSOR DE VEÍCULOS -> SSX" acima (upload -> mapear colunas ->
// ajustar/transformar -> validar -> exportar), rodando no servidor
// (conversor_rastreadores.py + validador_importacao/) — domínio bem menor
// (10 campos, sem "slots" repetidos), então sem GT06/cores de ícone, mas com
// botão "Templates" (Template + Status de rastreador são referências que
// precisam já existir na SSX).
const convrstInputArquivo = el("convrst-input-arquivo");
const convrstArquivoNome = el("convrst-arquivo-nome");
const convrstSecaoMapeamento = el("convrst-secao-mapeamento");
const convrstMapaCampos = el("convrst-mapa-campos");
const convrstMapaResumo = el("convrst-mapa-resumo");
const convrstMapaResumoTexto = el("convrst-mapa-resumo-texto");
const convrstMapaDetalhe = el("convrst-mapa-detalhe");
const btnConvrstMapear = el("btn-convrst-mapear");
const convrstSecaoTrabalho = el("convrst-secao-trabalho");
const convrstResumo = el("convrst-resumo");
const convrstTabelaThead = el("convrst-tabela-thead");
const convrstTabelaTbody = el("convrst-tabela-tbody");
const convrstTabelaElemento = convrstTabelaThead.closest("table");
const convrstTamanhoPagina = el("convrst-tamanho-pagina");
const convrstPaginacao = el("convrst-paginacao");
const convrstTabelaArea = el("convrst-tabela-area");
const CONVRST_LARGURAS_KEY = "larguraColunas_convrstRastreadores";

function ajustarAlturaConvrstTabelaArea() {
  if (!convrstTabelaArea || !elConteudoPrincipal) return;
  convrstTabelaArea.style.height = `${elConteudoPrincipal.clientHeight - 24}px`;
}
if (elConteudoPrincipal && window.ResizeObserver) {
  new ResizeObserver(ajustarAlturaConvrstTabelaArea).observe(elConteudoPrincipal);
}
window.addEventListener("resize", ajustarAlturaConvrstTabelaArea);

let convrstFileId = null;
let convrstColunasOrigem = [];
let convrstCampos = [];
let convrstCamposMapeados = [];
let convrstRegistros = [];
let convrstProblemasPorIndice = {};
let convrstDuplicadosPorIndice = {};
let convrstNomeBase = "rastreadores";
let convrstPagina = 1;
let convrstOrdenacao = null;

// Autenticação na SSX — flag PRÓPRIA desta tela (nunca estado.autenticado,
// de outra tela — ver gotcha nº1 do Conversor de Clientes).
let convrstSsxOk = false;
let convrstSsxLogin = "";
let convrstSsxBase = "";
let convrstSsxClaimsRaw = null;

function convrstAtualizarPillAuth() {
  const pill = el("convrst-status-auth");
  const btnLogout = el("btn-convrst-logout-ssx");
  if (convrstSsxOk) {
    pill.textContent = convrstSsxLogin
      ? `Autenticado na SSX (${convrstSsxLogin}${convrstSsxBase ? " — " + convrstSsxBase : ""})`
      : "Autenticado na SSX";
    pill.title = convrstSsxClaimsRaw ? JSON.stringify(convrstSsxClaimsRaw) : "";
    pill.className = "status-pill status-on";
    btnLogout.classList.remove("hidden");
  } else {
    pill.textContent = "Não autenticado na SSX";
    pill.className = "status-pill status-off";
    btnLogout.classList.add("hidden");
  }
}

// null = ainda não verificado na SSX nesta planilha; senão {templates:[...], status:[...]}
// vindo de /listar-templates-status — reseta ao trocar de arquivo.
let convrstTemplatesResultado = null;

function limparConvrst() {
  convrstFileId = null;
  convrstColunasOrigem = [];
  convrstCamposMapeados = [];
  convrstRegistros = [];
  convrstProblemasPorIndice = {};
  convrstDuplicadosPorIndice = {};
  convrstSsxOk = false;
  convrstSsxLogin = "";
  convrstSsxBase = "";
  convrstSsxClaimsRaw = null;
  convrstAtualizarPillAuth();
  convrstNomeBase = "rastreadores";
  convrstPagina = 1;
  convrstOrdenacao = null;
  convrstInputArquivo.value = "";
  convrstArquivoNome.textContent = "Nenhum arquivo selecionado";
  convrstSecaoMapeamento.classList.add("hidden");
  convrstSecaoTrabalho.classList.add("hidden");
  convrstMapaResumo.classList.add("hidden");
  convrstMapaDetalhe.classList.remove("hidden");
  convrstMapaCampos.innerHTML = "";
  convrstResumo.innerHTML = "";
  convrstTabelaThead.innerHTML = "";
  convrstTabelaTbody.innerHTML = "";
  convrstPaginacao.innerHTML = "";
  btnConvrstMapear.disabled = true;
  convrstTemplatesResultado = null;
}
limparConvrst();

// mostrarErro() genérico escreve no painel "Saída", escondido em Ferramentas
// Auxiliares (ver gotcha nº2 do Conversor de Clientes) — por isso função
// própria, que escreve dentro desta sub-tela.
function mostrarErroConvrst(msg) {
  convrstResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  convrstResumo.appendChild(p);
}

function mostrarInfoConvrst(msg) {
  convrstResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = msg;
  convrstResumo.appendChild(p);
}

async function carregarConvrstCampos() {
  if (convrstCampos.length) return convrstCampos;
  const r = await fetch("/api/conversor-rastreadores/campos");
  const data = await parseJsonResponse(r);
  if (!data.ok) throw new Error(data.error || "Falha ao carregar os campos da SSX.");
  convrstCampos = data.campos;
  return convrstCampos;
}

// Mapeamento padrão: posicional, pela ordem oficial do manual da SSX — mesma
// regra do Conversor de Clientes/Veículos.
function renderConvrstMapaCampos() {
  convrstMapaCampos.innerHTML = "";
  convrstCampos.forEach((campo, i) => {
    const linha = document.createElement("div");
    linha.className = "convcli-mapa-linha";

    const nome = document.createElement("span");
    nome.className = "convcli-mapa-nome";
    const marca = campo.obrigatorio === true ? " *" : campo.obrigatorio === "condicional" ? " (condicional)" : "";
    nome.textContent = campo.rotulo + marca;
    nome.title = campo.rotulo + marca;

    const select = document.createElement("select");
    select.dataset.campo = campo.chave;
    const optVazio = document.createElement("option");
    optVazio.value = "";
    optVazio.textContent = "— não mapear —";
    select.appendChild(optVazio);
    convrstColunasOrigem.forEach((col) => {
      const opt = document.createElement("option");
      opt.value = col;
      opt.textContent = col;
      select.appendChild(opt);
    });
    if (convrstColunasOrigem[i] !== undefined) select.value = convrstColunasOrigem[i];

    linha.appendChild(nome);
    linha.appendChild(select);
    convrstMapaCampos.appendChild(linha);
  });
}

el("btn-convrst-mapear-limpar").addEventListener("click", () => {
  convrstMapaCampos.querySelectorAll("select").forEach((sel) => { sel.value = ""; });
});

el("btn-convrst-mapear-auto").addEventListener("click", () => {
  convrstMapaCampos.querySelectorAll("select").forEach((sel, i) => {
    sel.value = convrstColunasOrigem[i] !== undefined ? convrstColunasOrigem[i] : "";
  });
});

el("btn-convrst-mapa-editar").addEventListener("click", () => {
  convrstMapaResumo.classList.add("hidden");
  convrstMapaDetalhe.classList.remove("hidden");
});

convrstInputArquivo.addEventListener("change", async () => {
  const file = convrstInputArquivo.files[0];
  if (!file) return;
  convrstArquivoNome.textContent = "Enviando...";
  convrstSecaoTrabalho.classList.add("hidden");
  convrstSecaoMapeamento.classList.add("hidden");
  convrstSsxOk = false;
  convrstDuplicadosPorIndice = {};
  convrstAtualizarPillAuth();
  resetarConvrstGt06();
  convrstTemplatesResultado = null;
  try {
    await carregarConvrstCampos();
    const formData = new FormData();
    formData.append("arquivo", file);
    const r = await fetch("/api/conversor-rastreadores/upload", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      convrstArquivoNome.textContent = "Nenhum arquivo selecionado";
      return mostrarErroConvrst(data.error || "Falha ao enviar arquivo.");
    }
    convrstFileId = data.file_id;
    convrstColunasOrigem = data.colunas;
    convrstNomeBase = file.name.replace(/\.(xlsx|xls|csv)$/i, "");
    convrstArquivoNome.textContent = `${file.name} (${data.total_linhas} linha(s))`;
    renderConvrstMapaCampos();
    convrstSecaoMapeamento.classList.remove("hidden");
    btnConvrstMapear.disabled = false;
  } catch (err) {
    convrstArquivoNome.textContent = "Nenhum arquivo selecionado";
    mostrarErroConvrst(err.message || String(err));
  }
});

btnConvrstMapear.addEventListener("click", async () => {
  const mapping = {};
  convrstMapaCampos.querySelectorAll("select").forEach((sel) => {
    if (sel.value) mapping[sel.dataset.campo] = sel.value;
  });
  if (Object.keys(mapping).length === 0) {
    return mostrarErroConvrst("Mapeie ao menos uma coluna antes de continuar.");
  }
  btnConvrstMapear.disabled = true;
  btnConvrstMapear.textContent = "Aplicando...";
  try {
    const r = await fetch("/api/conversor-rastreadores/mapear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convrstFileId, mapping }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvrst(data.error || "Falha ao aplicar o mapeamento.");
    convrstRegistros = data.registros;
    convrstCamposMapeados = convrstCampos.filter((c) => mapping[c.chave]);
    convrstProblemasPorIndice = {};
    convrstDuplicadosPorIndice = {};
    convrstPagina = 1;
    convrstOrdenacao = null;
    convrstSecaoTrabalho.classList.remove("hidden");
    ajustarAlturaConvrstTabelaArea();
    renderConvrstTabelaCabecalho();
    renderConvrstTabela();
    await rodarValidacaoConvrst();

    const n = convrstCamposMapeados.length;
    convrstMapaResumoTexto.textContent = `${n} campo${n === 1 ? "" : "s"} mapeado${n === 1 ? "" : "s"}.`;
    convrstMapaDetalhe.classList.add("hidden");
    convrstMapaResumo.classList.remove("hidden");
  } catch (err) {
    mostrarErroConvrst(err.message || String(err));
  } finally {
    btnConvrstMapear.disabled = false;
    btnConvrstMapear.textContent = "Aplicar mapeamento";
  }
});

function convrstValorColuna(registro, chave) {
  if (chave === "indice") return registro.indice;
  if (chave === "problema") return convrstRegistroTemProblema(registro.indice) ? 1 : 0;
  return registro.dados[chave];
}

function ordenarConvrstRegistros(registros) {
  if (!convrstOrdenacao) return registros;
  const { chave, direcao } = convrstOrdenacao;
  return registros.slice().sort((a, b) => {
    const va = valorOrdenavel(convrstValorColuna(a, chave));
    const vb = valorOrdenavel(convrstValorColuna(b, chave));
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * direcao;
    return String(va).localeCompare(String(vb), "pt-BR", { numeric: true, sensitivity: "base" }) * direcao;
  });
}

function renderConvrstTabelaCabecalho() {
  convrstTabelaThead.innerHTML = "";
  const tr = document.createElement("tr");

  const criarThOrdenavel = (texto, chave, larguraPadrao) => {
    const th = document.createElement("th");
    th.className = "th-ordenavel";
    th.style.width = `${larguraPadrao}px`;
    th.textContent = texto;
    if (convrstOrdenacao && convrstOrdenacao.chave === chave) {
      const seta = document.createElement("span");
      seta.className = "seta-ordenacao";
      seta.textContent = convrstOrdenacao.direcao === 1 ? " ▲" : " ▼";
      th.appendChild(seta);
    }
    th.addEventListener("click", () => {
      const direcao = convrstOrdenacao && convrstOrdenacao.chave === chave ? -convrstOrdenacao.direcao : 1;
      convrstOrdenacao = { chave, direcao };
      convrstPagina = 1;
      renderConvrstTabelaCabecalho();
      renderConvrstTabela();
    });
    return th;
  };

  // "Linha" e "Problema" — colunas próprias, congeladas, só com ordenação
  // (sem filtro) — reaproveita as classes "convvei-th-linha"/"convvei-td-
  // linha"/etc. (só visuais, não específicas de veículo — ver style.css).
  const thLinha = criarThOrdenavel("Linha", "indice", 52);
  thLinha.classList.add("convvei-th-linha");
  tr.appendChild(thLinha);
  const thProblema = criarThOrdenavel("Prob.", "problema", 40);
  thProblema.classList.add("convvei-th-problema");
  tr.appendChild(thProblema);

  convrstCamposMapeados.forEach((campo) => tr.appendChild(criarThOrdenavel(campo.rotulo, campo.chave, 180)));

  const thAcoes = document.createElement("th");
  thAcoes.style.width = "46px";
  thAcoes.textContent = "";
  tr.appendChild(thAcoes);

  convrstTabelaThead.appendChild(tr);
}

function convrstTotalPaginas() {
  return Math.max(1, Math.ceil(convrstRegistros.length / Number(convrstTamanhoPagina.value)));
}

function convrstProblemaCombinado(indice) {
  const a = convrstProblemasPorIndice[indice];
  const b = convrstDuplicadosPorIndice[indice];
  if (!a && !b) return null;
  return {
    erros: [...(a ? a.erros : []), ...(b ? b.erros : [])],
    avisos: [...(a ? a.avisos : []), ...(b ? b.avisos : [])],
  };
}

function convrstRegistroTemProblema(indice) {
  const p = convrstProblemaCombinado(indice);
  return !!(p && (p.erros.length > 0 || p.avisos.length > 0));
}

function montarLinhaConvrst(registro) {
  const tr = document.createElement("tr");
  tr.dataset.indice = registro.indice;
  const problema = convrstProblemaCombinado(registro.indice);

  const tdLinha = document.createElement("td");
  tdLinha.className = "convvei-td-linha";
  tdLinha.textContent = String(registro.indice);
  tr.appendChild(tdLinha);

  const tdProblema = document.createElement("td");
  tdProblema.className = "convvei-td-problema";
  let icone = "";
  if (problema && problema.erros.length > 0) {
    icone = "🔴";
    tr.classList.add("conversor-edicao-linha-erro");
  } else if (problema && problema.avisos.length > 0) {
    icone = "⚠️";
  } else if (problema) {
    icone = "✓";
  }
  tdProblema.textContent = icone;
  if (problema) {
    const msgs = [...problema.erros.map((e) => `⛔ ${e.mensagem}`), ...problema.avisos.map((a) => `⚠️ ${a.mensagem}`)];
    tr.title = msgs.join("\n");
    tdProblema.title = tr.title;
  }
  tr.appendChild(tdProblema);

  // "duplicado_ssx" (vermelho) e "nao_cadastrado_ssx" (vermelho também —
  // referência que deveria existir na SSX e não existe) vêm de "Verificar na
  // SSX"; "duplicado_planilha" (amarelo) é só dentro da própria planilha.
  const duplicadosPorCampo = {};
  if (problema) {
    const todos = [...problema.erros, ...problema.avisos];
    todos.filter((p) => p.categoria === "duplicado_planilha").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
    todos.filter((p) => p.categoria === "duplicado_ssx" || p.categoria === "nao_cadastrado_ssx").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
  }

  convrstCamposMapeados.forEach((campo) => {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.value = registro.dados[campo.chave] || "";
    const duplicado = duplicadosPorCampo[campo.rotulo];
    if (duplicado) {
      input.classList.add((duplicado.categoria === "duplicado_ssx" || duplicado.categoria === "nao_cadastrado_ssx") ? "convcli-campo-duplicado" : "convcli-campo-duplicado-planilha");
      input.title = duplicado.mensagem;
    }
    input.addEventListener("change", async () => {
      registro.dados[campo.chave] = input.value;
      try {
        const r = await fetch("/api/conversor-rastreadores/editar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: convrstFileId, indice: registro.indice, campo: campo.chave, valor: input.value }),
        });
        const data = await parseJsonResponse(r);
        if (!data.ok) return mostrarErroConvrst(data.error || "Falha ao salvar a edição.");
        await rodarValidacaoConvrst();
      } catch (err) {
        mostrarErroConvrst(err.message || String(err));
      }
    });
    td.appendChild(input);
    tr.appendChild(td);
  });

  const tdAcoes = document.createElement("td");
  tdAcoes.className = "convcli-td-acoes";
  const btnExcluir = document.createElement("button");
  btnExcluir.type = "button";
  btnExcluir.className = "btn-secondary convcli-btn-excluir-linha";
  btnExcluir.textContent = "🗑️";
  btnExcluir.title = "Excluir esta linha";
  btnExcluir.addEventListener("click", () => excluirLinhaConvrst(registro.indice));
  tdAcoes.appendChild(btnExcluir);
  tr.appendChild(tdAcoes);

  return tr;
}

function renderConvrstTabela() {
  const tamanho = Number(convrstTamanhoPagina.value);
  const registrosOrdenados = ordenarConvrstRegistros(convrstRegistros);
  convrstPagina = Math.min(Math.max(1, convrstPagina), convrstTotalPaginas());
  const inicio = (convrstPagina - 1) * tamanho;
  convrstTabelaTbody.innerHTML = "";
  registrosOrdenados.slice(inicio, inicio + tamanho).forEach((r) => convrstTabelaTbody.appendChild(montarLinhaConvrst(r)));
  tornarColunasRedimensionaveis(convrstTabelaElemento, CONVRST_LARGURAS_KEY, { 0: 52, 1: 40 });
  atualizarConvrstGt06Lista();

  convrstPaginacao.innerHTML = "";
  const total = convrstTotalPaginas();
  if (total > 1) {
    const anterior = document.createElement("button");
    anterior.type = "button";
    anterior.className = "btn-secondary";
    anterior.textContent = "‹ Anterior";
    anterior.disabled = convrstPagina === 1;
    anterior.addEventListener("click", () => { convrstPagina--; renderConvrstTabela(); });
    const info = document.createElement("span");
    info.textContent = `Página ${convrstPagina} de ${total}`;
    const proxima = document.createElement("button");
    proxima.type = "button";
    proxima.className = "btn-secondary";
    proxima.textContent = "Próxima ›";
    proxima.disabled = convrstPagina === total;
    proxima.addEventListener("click", () => { convrstPagina++; renderConvrstTabela(); });
    [anterior, info, proxima].forEach((n) => convrstPaginacao.appendChild(n));
  }
}
convrstTamanhoPagina.addEventListener("change", () => { convrstPagina = 1; renderConvrstTabela(); });

// --- EXCLUIR / ADICIONAR LINHA (Conversor de Rastreadores) ---
async function excluirLinhaConvrst(indice) {
  if (!convrstFileId) return;
  if (!confirm(`Excluir a linha ${indice}? Essa ação não pode ser desfeita.`)) return;
  try {
    const r = await fetch("/api/conversor-rastreadores/excluir-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convrstFileId, indice }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvrst(data.error || "Falha ao excluir a linha.");
    convrstRegistros = convrstRegistros.filter((r2) => r2.indice !== indice);
    delete convrstDuplicadosPorIndice[indice];
    await rodarValidacaoConvrst();
    mostrarInfoConvrst(`Linha ${indice} excluída.`);
  } catch (err) {
    mostrarErroConvrst(err.message || String(err));
  }
}

el("btn-convrst-adicionar-linha").addEventListener("click", async () => {
  if (!convrstFileId) return;
  try {
    const r = await fetch("/api/conversor-rastreadores/adicionar-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convrstFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvrst(data.error || "Falha ao adicionar a linha.");
    convrstRegistros.push(data.registro);
    convrstOrdenacao = null;
    renderConvrstTabelaCabecalho();
    convrstPagina = convrstTotalPaginas();
    await rodarValidacaoConvrst();
    mostrarInfoConvrst(`Linha ${data.registro.indice} adicionada — preencha os campos.`);
  } catch (err) {
    mostrarErroConvrst(err.message || String(err));
  }
});

el("btn-convrst-limpar-vazias").addEventListener("click", async () => {
  if (!convrstFileId) return;
  try {
    const r = await fetch("/api/conversor-rastreadores/limpar-vazias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convrstFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvrst(data.error || "Falha ao limpar as linhas vazias.");
    convrstRegistros = convrstRegistros.filter((reg) => Object.values(reg.dados).some((v) => (v || "").trim()));
    convrstPagina = 1;
    await rodarValidacaoConvrst();
    mostrarInfoConvrst(data.removidos ? `${data.removidos} linha(s) vazia(s) removida(s).` : "Nenhuma linha vazia encontrada.");
  } catch (err) {
    mostrarErroConvrst(err.message || String(err));
  }
});

// Transformações em massa: roda no servidor sobre TODAS as linhas mapeadas e
// devolve só os registros que mudaram — mesmo padrão de
// rodarTransformacaoConvvei.
async function rodarTransformacaoConvrst(acao, params, montarMensagem) {
  if (!convrstFileId) return;
  try {
    const r = await fetch("/api/conversor-rastreadores/transformar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convrstFileId, acao, params: params || {} }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvrst(data.error || "Falha ao aplicar a transformação.");
    const porIndice = new Map(data.registros.map((r2) => [r2.indice, r2]));
    convrstRegistros = convrstRegistros.map((r2) => porIndice.get(r2.indice) || r2);
    await rodarValidacaoConvrst();
    mostrarInfoConvrst(montarMensagem ? montarMensagem(data) : `${data.total_alterados} registro(s) alterado(s).`);
  } catch (err) {
    mostrarErroConvrst(err.message || String(err));
  }
}

el("btn-convrst-limpar-iccid1").addEventListener("click", () =>
  rodarTransformacaoConvrst("limpar_campo", { campo: "iccid1" }, (data) => `${data.ajustados} ICCID1 limpo(s).`));
el("btn-convrst-limpar-iccid2").addEventListener("click", () =>
  rodarTransformacaoConvrst("limpar_campo", { campo: "iccid2" }, (data) => `${data.ajustados} ICCID2 limpo(s).`));
el("btn-convrst-limpar-imei").addEventListener("click", () =>
  rodarTransformacaoConvrst("limpar_campo", { campo: "imei" }, (data) => `${data.ajustados} IMEI limpo(s).`));

el("btn-convrst-repetir-identificacao-codigo").addEventListener("click", () => {
  rodarTransformacaoConvrst(
    "repetir_campo", { origem: "identificacao", destino: "codigo_integracao" },
    (data) => `${data.repetidos} identificação(ões) repetida(s) em Código de integração.`
  );
});

// "Padrão GT06": a lista de templates distintos usados na planilha
// (considerando TODAS as linhas, não só a página visível — vem de
// convrstRegistros, já carregado inteiro em memória) aparece sozinha, sem
// precisar de um botão "identificar" — atualizarConvrstGt06Lista() é
// chamada a cada renderConvrstTabela() (ou seja, a cada upload/mapeamento/
// transformação/edição/validação). Só mexe no DOM quando a lista de
// templates realmente muda, pra não perder o que já estava marcado nem o
// foco só por causa de troca de página. Mesmo padrão de
// atualizarConvveiGt06Lista (Conversor de Veículos) — aqui sem "slot" de
// rastreador (só existe um "Template"/"Identificação" por linha).
const convrstGt06Vazio = el("convrst-gt06-vazio");
const convrstGt06Lista = el("convrst-gt06-lista");
const convrstGt06AplicarWrap = el("convrst-gt06-aplicar-wrap");
let convrstGt06UltimaListaTemplates = null; // string[] da última renderização
let convrstGt06Marcados = new Set(); // nomes marcados — sobrevive a reconstruções da lista

function resetarConvrstGt06() {
  convrstGt06UltimaListaTemplates = null;
  convrstGt06Marcados = new Set();
  convrstGt06Lista.innerHTML = "";
  convrstGt06Lista.classList.add("hidden");
  convrstGt06AplicarWrap.classList.add("hidden");
  convrstGt06Vazio.classList.remove("hidden");
}

function atualizarConvrstGt06Lista() {
  const templates = convrstValoresDistintos("template");
  const mudou = !convrstGt06UltimaListaTemplates
    || templates.length !== convrstGt06UltimaListaTemplates.length
    || templates.some((t, i) => t !== convrstGt06UltimaListaTemplates[i]);
  if (!mudou) return;
  convrstGt06UltimaListaTemplates = templates;
  convrstGt06Marcados = new Set([...convrstGt06Marcados].filter((t) => templates.includes(t)));

  convrstGt06Lista.innerHTML = "";
  if (templates.length === 0) {
    convrstGt06Lista.classList.add("hidden");
    convrstGt06AplicarWrap.classList.add("hidden");
    convrstGt06Vazio.classList.remove("hidden");
    return;
  }
  templates.forEach((t, i) => {
    const label = document.createElement("label");
    label.className = "convcli-checkbox-inline";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = t;
    input.id = `convrst-gt06-template-${i}`;
    input.checked = convrstGt06Marcados.has(t);
    input.addEventListener("change", () => {
      if (input.checked) convrstGt06Marcados.add(t);
      else convrstGt06Marcados.delete(t);
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(t));
    convrstGt06Lista.appendChild(label);
  });
  convrstGt06Vazio.classList.add("hidden");
  convrstGt06Lista.classList.remove("hidden");
  convrstGt06AplicarWrap.classList.remove("hidden");
}

function convrstGt06Selecionados() {
  return Array.from(convrstGt06Marcados);
}

el("btn-convrst-gt06-aplicar").addEventListener("click", () => {
  const selecionados = convrstGt06Selecionados();
  if (selecionados.length === 0) {
    return mostrarErroConvrst("Selecione ao menos um template antes de aplicar o padrão GT06.");
  }
  rodarTransformacaoConvrst("aplicar_gt06", { templates: selecionados }, (data) =>
    `${data.ajustados} identificação(ões) e ${data.ajustados_codigo_integracao} código(s) de integração ajustado(s) (zero inicial) para o(s) template(s): ${selecionados.join(", ")}.`);
});

// "Limpar padrão GT06": remove só o 1º zero do início da identificação E do
// código de integração — oposto de "Aplicar padrão GT06". Sem nenhum
// template marcado, vale pra TODOS os templates da lista (ver
// conversor_rastreadores.limpar_padrao_gt06), mas só depois de confirmar —
// ação mais ampla, risco maior de engano.
el("btn-convrst-gt06-limpar").addEventListener("click", () => {
  const selecionados = convrstGt06Selecionados();
  if (selecionados.length === 0) {
    const confirmado = confirm(
      "Nenhum template selecionado. Isso vai remover o zero inicial da identificação e do código de integração de TODOS os templates da lista. Confirma?"
    );
    if (!confirmado) return;
  }
  rodarTransformacaoConvrst("limpar_gt06", { templates: selecionados }, (data) =>
    `${data.ajustados} identificação(ões) e ${data.ajustados_codigo_integracao} código(s) de integração com o zero inicial removido`
    + (selecionados.length ? ` para o(s) template(s): ${selecionados.join(", ")}.` : " (todos os templates)."));
});

// "Preencher pra todas as linhas" — um único handler genérico (acao
// "preencher_campo", igual o backend espera), reaproveitado pelos 3 botões
// de Template/Status/Código do cliente.
function ligarBtnConvrstPreencherTodas(idBotao, idInput, campo, rotuloErro) {
  el(idBotao).addEventListener("click", () => {
    const valor = el(idInput).value.trim();
    if (!valor) return mostrarErroConvrst(`Informe ${rotuloErro} a ser preenchido.`);
    rodarTransformacaoConvrst("preencher_campo", { campo, valor }, (data) =>
      `${data.preenchidos} linha(s) preenchida(s) com "${valor}".`);
  });
}
ligarBtnConvrstPreencherTodas("btn-convrst-preencher-template", "convrst-template-valor", "template", "o template");
ligarBtnConvrstPreencherTodas("btn-convrst-preencher-status", "convrst-status-valor", "status", "o status");
ligarBtnConvrstPreencherTodas("btn-convrst-preencher-cliente", "convrst-cliente-valor", "codigo_integracao_cliente", "o código do cliente");

function renderConvrstResumo(data) {
  convrstResumo.innerHTML = "";
  const tiles = document.createElement("div");
  tiles.className = "dashboard-tiles";
  [
    { valor: data.n_ok, label: "Válidos" },
    { valor: data.n_erro, label: "Com erro", clicavel: data.n_erro > 0 },
  ].forEach(({ valor, label, clicavel }) => {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const l = document.createElement("div");
    l.className = "stat-tile-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "stat-tile-valor";
    v.textContent = valor;
    tile.appendChild(l);
    tile.appendChild(v);
    if (clicavel) {
      tile.classList.add("stat-tile-clicavel");
      tile.title = "Ir para o primeiro registro com erro";
      tile.addEventListener("click", irParaPrimeiroErroConvrst);
    }
    tiles.appendChild(tile);
  });
  convrstResumo.appendChild(tiles);
  const legenda = document.createElement("p");
  legenda.className = "placeholder";
  legenda.textContent = `${data.n_ok} de ${data.total} registro(s) válidos para importar.`;
  convrstResumo.appendChild(legenda);
}

function irParaPrimeiroErroConvrst() {
  const ordenados = ordenarConvrstRegistros(convrstRegistros);
  const posicao = ordenados.findIndex((r) => {
    const p = convrstProblemaCombinado(r.indice);
    return p && p.erros.length > 0;
  });
  if (posicao === -1) return;

  const tamanho = Number(convrstTamanhoPagina.value);
  convrstPagina = Math.floor(posicao / tamanho) + 1;
  renderConvrstTabela();

  const indice = ordenados[posicao].indice;
  const tr = convrstTabelaTbody.querySelector(`tr[data-indice="${indice}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: "smooth", block: "center" });
  tr.classList.add("convcli-linha-destacada");
  setTimeout(() => tr.classList.remove("convcli-linha-destacada"), 2200);
}

async function rodarValidacaoConvrst() {
  if (!convrstFileId) return null;
  try {
    const r = await fetch("/api/conversor-rastreadores/validar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convrstFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvrst(data.error || "Falha ao validar.");
      return null;
    }
    convrstProblemasPorIndice = {};
    data.problemas.forEach((p) => { convrstProblemasPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvrstResumo(data);
    renderConvrstTabela();
    return data;
  } catch (err) {
    mostrarErroConvrst(err.message || String(err));
    return null;
  }
}
el("btn-convrst-validar").addEventListener("click", () => rodarValidacaoConvrst());

// --- VERIFICAR DUPLICIDADE NA SSX (Conversor de Rastreadores, opcional) ---
const overlayConvrstLogin = el("overlay-convrst-login");
const selectConvrstCredencial = el("convrst-select-credencial");

function renderSelectConvrstCredenciais() {
  selectConvrstCredencial.innerHTML = '<option value="">Login salvo...</option>';
  credenciaisCache.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.nome;
    selectConvrstCredencial.appendChild(opt);
  });
}

selectConvrstCredencial.addEventListener("change", () => {
  const cred = credenciaisCache.find((c) => c.id === selectConvrstCredencial.value);
  if (!cred) return;
  el("convrst-login").value = cred.login;
  el("convrst-senha").value = cred.senha;
  selectConvrstCredencial.value = "";
});

// Callback setado antes de abrir o login, executado 1x depois de autenticar
// e resetado pra null em todo caminho que fecha/reabre o modal — mesmo
// padrão de convcliLoginAoEntrar (ver gotcha nº3 do Conversor de Clientes).
let convrstLoginAoEntrar = null;

el("convrst-login-fechar").addEventListener("click", () => {
  convrstLoginAoEntrar = null;
  overlayConvrstLogin.classList.add("hidden");
});

el("form-convrst-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const login = el("convrst-login").value.trim();
  const senha = el("convrst-senha").value;
  if (!login || !senha) return;
  const btn = el("btn-convrst-autenticar");
  btn.disabled = true;
  btn.textContent = "Entrando...";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, senha }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvrst(data.error || "Falha ao autenticar na SSX.");
      return;
    }
    convrstSsxOk = true;
    convrstSsxLogin = login;
    convrstSsxBase = extrairNomeBaseDeClaims(data.claims);
    convrstSsxClaimsRaw = data.claims || null;
    convrstAtualizarPillAuth();
    overlayConvrstLogin.classList.add("hidden");
    el("convrst-senha").value = "";
    const aoEntrar = convrstLoginAoEntrar;
    convrstLoginAoEntrar = null;
    if (aoEntrar) return await aoEntrar();
    await rodarVerificacaoDuplicidadeConvrst();
  } catch (err) {
    mostrarErroConvrst(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
});

el("btn-convrst-logout-ssx").addEventListener("click", async () => {
  await fetch("/api/logout-avulso", { method: "POST" });
  convrstSsxOk = false;
  convrstSsxLogin = "";
  convrstSsxBase = "";
  convrstSsxClaimsRaw = null;
  convrstAtualizarPillAuth();
  convrstDuplicadosPorIndice = {};
  renderConvrstTabela();
  mostrarInfoConvrst("Sessão da SSX encerrada.");
});

async function rodarVerificacaoDuplicidadeConvrst() {
  if (!convrstFileId) return null;
  const btn = el("btn-convrst-verificar-ssx");
  btn.disabled = true;
  btn.textContent = "Verificando...";
  try {
    const r = await fetch("/api/conversor-rastreadores/verificar-duplicidade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convrstFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (r.status === 401 || r.status === 409) {
        convrstSsxOk = false;
        convrstAtualizarPillAuth();
        renderSelectConvrstCredenciais();
        overlayConvrstLogin.classList.remove("hidden");
        return null;
      }
      mostrarErroConvrst(data.error || "Falha ao verificar duplicidade na SSX.");
      return null;
    }
    convrstDuplicadosPorIndice = {};
    data.problemas.forEach((p) => { convrstDuplicadosPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvrstTabela();
    mostrarInfoConvrst(
      data.total_duplicados
        ? `${data.total_duplicados} de ${data.total_verificados} registro(s) com possível problema na SSX (duplicata ou referência — template, status, cliente, ICCID — não cadastrada).`
        : `Nenhum problema encontrado entre os ${data.total_verificados} registro(s) verificados (duplicata e referências na SSX).`
    );
    return data;
  } catch (err) {
    mostrarErroConvrst(err.message || String(err));
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = "Verificar na SSX";
  }
}

el("btn-convrst-verificar-ssx").addEventListener("click", () => {
  if (!convrstFileId) return;
  if (!convrstSsxOk) {
    convrstLoginAoEntrar = null;
    renderSelectConvrstCredenciais();
    overlayConvrstLogin.classList.remove("hidden");
    return;
  }
  rodarVerificacaoDuplicidadeConvrst();
});

// Botão "Templates": lista os Templates e Status de rastreador usados na
// planilha inteira — aparece SEMPRE, direto de convrstRegistros (já em
// memória), sem exigir login. A cor vermelha (⚠ "falta cadastrar") é um
// passo à parte e opcional ("Verificar cadastro na SSX" dentro do modal),
// que só então pede autenticação — mesma sessão/login de "Verificar na SSX"
// (convrstSsxOk/convrstLoginAoEntrar).
const overlayConvrstTemplates = el("overlay-convrst-templates");
const convrstTemplatesListaTemplates = el("convrst-templates-lista-templates");
const convrstTemplatesListaStatus = el("convrst-templates-lista-status");
const convrstTemplatesLegenda = el("convrst-templates-legenda");

function convrstValoresDistintos(chave) {
  const vistos = new Set();
  convrstRegistros.forEach((r) => {
    const valor = (r.dados[chave] || "").trim();
    if (valor) vistos.add(valor);
  });
  return Array.from(vistos).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
}

function renderConvrstTemplatesLista(container, itens) {
  container.innerHTML = "";
  itens.forEach(({ valor, cadastrado }) => {
    const li = document.createElement("li");
    if (cadastrado === false) {
      li.classList.add("convvei-templates-faltando");
      li.textContent = `⚠ ${valor}`;
      li.title = "Falta cadastrar na SSX";
    } else if (cadastrado === true) {
      li.textContent = `✓ ${valor}`;
      li.title = "Já cadastrado na SSX";
    } else {
      li.textContent = valor;
    }
    container.appendChild(li);
  });
}

function renderConvrstTemplatesModal() {
  if (convrstTemplatesResultado) {
    renderConvrstTemplatesLista(convrstTemplatesListaTemplates, convrstTemplatesResultado.templates);
    renderConvrstTemplatesLista(convrstTemplatesListaStatus, convrstTemplatesResultado.status);
    convrstTemplatesLegenda.textContent = "⚠ em vermelho = falta cadastrar na SSX; ✓ = já cadastrado.";
  } else {
    const templates = convrstValoresDistintos("template").map((valor) => ({ valor }));
    const status = convrstValoresDistintos("status").map((valor) => ({ valor }));
    renderConvrstTemplatesLista(convrstTemplatesListaTemplates, templates);
    renderConvrstTemplatesLista(convrstTemplatesListaStatus, status);
    convrstTemplatesLegenda.textContent = 'Valores usados na planilha — clique em "Verificar cadastro na SSX" pra ver o que já está cadastrado.';
  }
}

async function verificarConvrstTemplatesNaSsx() {
  if (!convrstFileId) return;
  const btn = el("btn-convrst-templates-verificar-ssx");
  btn.disabled = true;
  btn.textContent = "Verificando...";
  try {
    const r = await fetch("/api/conversor-rastreadores/listar-templates-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convrstFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (r.status === 401 || r.status === 409) {
        convrstSsxOk = false;
        convrstAtualizarPillAuth();
        convrstLoginAoEntrar = verificarConvrstTemplatesNaSsx;
        renderSelectConvrstCredenciais();
        overlayConvrstLogin.classList.remove("hidden");
        return;
      }
      mostrarErroConvrst(data.error || "Falha ao consultar templates/status na SSX.");
      return;
    }
    convrstTemplatesResultado = { templates: data.templates, status: data.status };
    renderConvrstTemplatesModal();
  } catch (err) {
    mostrarErroConvrst(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Verificar cadastro na SSX";
  }
}

el("btn-convrst-templates").addEventListener("click", () => {
  if (!convrstFileId) {
    return mostrarErroConvrst("Carregue e mapeie uma planilha no Conversor de Rastreadores antes.");
  }
  renderConvrstTemplatesModal();
  overlayConvrstTemplates.classList.remove("hidden");
});

el("btn-convrst-templates-verificar-ssx").addEventListener("click", () => {
  if (!convrstSsxOk) {
    convrstLoginAoEntrar = verificarConvrstTemplatesNaSsx;
    renderSelectConvrstCredenciais();
    overlayConvrstLogin.classList.remove("hidden");
    return;
  }
  verificarConvrstTemplatesNaSsx();
});

el("convrst-templates-fechar").addEventListener("click", () => {
  overlayConvrstTemplates.classList.add("hidden");
});

function baixarConvrstArquivo(modo) {
  const a = document.createElement("a");
  a.href = `/api/conversor-rastreadores/exportar/${convrstFileId}/${modo}`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const overlayConvrstBaixarErro = el("overlay-convrst-baixar-erro");
const textoConvrstBaixarErro = el("convrst-baixar-erro-texto");
let resolverConvrstBaixarErro = null;
function fecharConvrstBaixarErro(escolha) {
  overlayConvrstBaixarErro.classList.add("hidden");
  const resolve = resolverConvrstBaixarErro;
  resolverConvrstBaixarErro = null;
  if (resolve) resolve(escolha);
}
function confirmarConvrstBaixarErro(nComErro) {
  const plural = nComErro === 1 ? "rastreador não passou" : "rastreadores não passaram";
  textoConvrstBaixarErro.textContent =
    `${nComErro} ${plural} na validação e podem ser rejeitados pelo SSX na importação. Baixe só os válidos, ou inclua os com erro pra corrigir depois.`;
  overlayConvrstBaixarErro.classList.remove("hidden");
  return new Promise((resolve) => { resolverConvrstBaixarErro = resolve; });
}
el("convrst-baixar-erro-fechar").addEventListener("click", () => fecharConvrstBaixarErro("cancelar"));
el("btn-convrst-baixar-erro-cancelar").addEventListener("click", () => fecharConvrstBaixarErro("cancelar"));
el("btn-convrst-baixar-com-erros").addEventListener("click", () => fecharConvrstBaixarErro("com-erros"));
el("btn-convrst-baixar-sem-erros").addEventListener("click", () => fecharConvrstBaixarErro("sem-erros"));

el("btn-convrst-baixar").addEventListener("click", async () => {
  if (!convrstFileId) return;
  const resultado = await rodarValidacaoConvrst();
  if (!resultado) return;
  if (resultado.n_erro > 0) {
    const escolha = await confirmarConvrstBaixarErro(resultado.n_erro);
    if (escolha === "cancelar") return;
    baixarConvrstArquivo(escolha === "com-erros" ? "todos" : "validos");
  } else {
    baixarConvrstArquivo("todos");
  }
});

el("btn-convrst-importar-api").addEventListener("click", () => {
  if (!convrstFileId) {
    return mostrarErroConvrst("Carregue e mapeie uma planilha no Conversor de Rastreadores antes.");
  }
  if (!convrstSsxOk) {
    convrstLoginAoEntrar = abrirModalImportDeConvrst;
    renderSelectConvrstCredenciais();
    overlayConvrstLogin.classList.remove("hidden");
    return;
  }
  abrirModalImportDeConvrst();
});

// --- CONVERSOR DE SIM CARDS -> SSX ---
// Sub-tela "/ferramentas/conversor-simcards": mesmo fluxo e mesmo molde das
// seções acima — domínio o mais simples da Central de Importação (10 campos,
// nenhum campo de referência a um cadastro que precise já existir na SSX —
// ver conversor_simcards.py), por isso sem botão "Templates" e com
// "Verificar na SSX" checando só duplicidade de ICCID.
const convsimInputArquivo = el("convsim-input-arquivo");
const convsimArquivoNome = el("convsim-arquivo-nome");
const convsimSecaoMapeamento = el("convsim-secao-mapeamento");
const convsimMapaCampos = el("convsim-mapa-campos");
const convsimMapaResumo = el("convsim-mapa-resumo");
const convsimMapaResumoTexto = el("convsim-mapa-resumo-texto");
const convsimMapaDetalhe = el("convsim-mapa-detalhe");
const btnConvsimMapear = el("btn-convsim-mapear");
const convsimSecaoTrabalho = el("convsim-secao-trabalho");
const convsimResumo = el("convsim-resumo");
const convsimTabelaThead = el("convsim-tabela-thead");
const convsimTabelaTbody = el("convsim-tabela-tbody");
const convsimTabelaElemento = convsimTabelaThead.closest("table");
const convsimTamanhoPagina = el("convsim-tamanho-pagina");
const convsimPaginacao = el("convsim-paginacao");
const convsimTabelaArea = el("convsim-tabela-area");
const CONVSIM_LARGURAS_KEY = "larguraColunas_convsimSimcards";

function ajustarAlturaConvsimTabelaArea() {
  if (!convsimTabelaArea || !elConteudoPrincipal) return;
  convsimTabelaArea.style.height = `${elConteudoPrincipal.clientHeight - 24}px`;
}
if (elConteudoPrincipal && window.ResizeObserver) {
  new ResizeObserver(ajustarAlturaConvsimTabelaArea).observe(elConteudoPrincipal);
}
window.addEventListener("resize", ajustarAlturaConvsimTabelaArea);

let convsimFileId = null;
let convsimColunasOrigem = [];
let convsimCampos = [];
let convsimCamposMapeados = [];
let convsimRegistros = [];
let convsimProblemasPorIndice = {};
let convsimDuplicadosPorIndice = {};
let convsimNomeBase = "simcards";
let convsimPagina = 1;
let convsimOrdenacao = null;

let convsimSsxOk = false;
let convsimSsxLogin = "";
let convsimSsxBase = "";
let convsimSsxClaimsRaw = null;

function convsimAtualizarPillAuth() {
  const pill = el("convsim-status-auth");
  const btnLogout = el("btn-convsim-logout-ssx");
  if (convsimSsxOk) {
    pill.textContent = convsimSsxLogin
      ? `Autenticado na SSX (${convsimSsxLogin}${convsimSsxBase ? " — " + convsimSsxBase : ""})`
      : "Autenticado na SSX";
    pill.title = convsimSsxClaimsRaw ? JSON.stringify(convsimSsxClaimsRaw) : "";
    pill.className = "status-pill status-on";
    btnLogout.classList.remove("hidden");
  } else {
    pill.textContent = "Não autenticado na SSX";
    pill.className = "status-pill status-off";
    btnLogout.classList.add("hidden");
  }
}

function limparConvsim() {
  convsimFileId = null;
  convsimColunasOrigem = [];
  convsimCamposMapeados = [];
  convsimRegistros = [];
  convsimProblemasPorIndice = {};
  convsimDuplicadosPorIndice = {};
  convsimSsxOk = false;
  convsimSsxLogin = "";
  convsimSsxBase = "";
  convsimSsxClaimsRaw = null;
  convsimAtualizarPillAuth();
  convsimNomeBase = "simcards";
  convsimPagina = 1;
  convsimOrdenacao = null;
  convsimInputArquivo.value = "";
  convsimArquivoNome.textContent = "Nenhum arquivo selecionado";
  convsimSecaoMapeamento.classList.add("hidden");
  convsimSecaoTrabalho.classList.add("hidden");
  convsimMapaResumo.classList.add("hidden");
  convsimMapaDetalhe.classList.remove("hidden");
  convsimMapaCampos.innerHTML = "";
  convsimResumo.innerHTML = "";
  convsimTabelaThead.innerHTML = "";
  convsimTabelaTbody.innerHTML = "";
  convsimPaginacao.innerHTML = "";
  btnConvsimMapear.disabled = true;
}
limparConvsim();

function mostrarErroConvsim(msg) {
  convsimResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  convsimResumo.appendChild(p);
}

function mostrarInfoConvsim(msg) {
  convsimResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = msg;
  convsimResumo.appendChild(p);
}

async function carregarConvsimCampos() {
  if (convsimCampos.length) return convsimCampos;
  const r = await fetch("/api/conversor-simcards/campos");
  const data = await parseJsonResponse(r);
  if (!data.ok) throw new Error(data.error || "Falha ao carregar os campos da SSX.");
  convsimCampos = data.campos;
  return convsimCampos;
}

function renderConvsimMapaCampos() {
  convsimMapaCampos.innerHTML = "";
  convsimCampos.forEach((campo, i) => {
    const linha = document.createElement("div");
    linha.className = "convcli-mapa-linha";

    const nome = document.createElement("span");
    nome.className = "convcli-mapa-nome";
    const marca = campo.obrigatorio === true ? " *" : campo.obrigatorio === "condicional" ? " (condicional)" : "";
    nome.textContent = campo.rotulo + marca;
    nome.title = campo.rotulo + marca;

    const select = document.createElement("select");
    select.dataset.campo = campo.chave;
    const optVazio = document.createElement("option");
    optVazio.value = "";
    optVazio.textContent = "— não mapear —";
    select.appendChild(optVazio);
    convsimColunasOrigem.forEach((col) => {
      const opt = document.createElement("option");
      opt.value = col;
      opt.textContent = col;
      select.appendChild(opt);
    });
    if (convsimColunasOrigem[i] !== undefined) select.value = convsimColunasOrigem[i];

    linha.appendChild(nome);
    linha.appendChild(select);
    convsimMapaCampos.appendChild(linha);
  });
}

el("btn-convsim-mapear-limpar").addEventListener("click", () => {
  convsimMapaCampos.querySelectorAll("select").forEach((sel) => { sel.value = ""; });
});

el("btn-convsim-mapear-auto").addEventListener("click", () => {
  convsimMapaCampos.querySelectorAll("select").forEach((sel, i) => {
    sel.value = convsimColunasOrigem[i] !== undefined ? convsimColunasOrigem[i] : "";
  });
});

el("btn-convsim-mapa-editar").addEventListener("click", () => {
  convsimMapaResumo.classList.add("hidden");
  convsimMapaDetalhe.classList.remove("hidden");
});

convsimInputArquivo.addEventListener("change", async () => {
  const file = convsimInputArquivo.files[0];
  if (!file) return;
  convsimArquivoNome.textContent = "Enviando...";
  convsimSecaoTrabalho.classList.add("hidden");
  convsimSecaoMapeamento.classList.add("hidden");
  convsimSsxOk = false;
  convsimDuplicadosPorIndice = {};
  convsimAtualizarPillAuth();
  try {
    await carregarConvsimCampos();
    const formData = new FormData();
    formData.append("arquivo", file);
    const r = await fetch("/api/conversor-simcards/upload", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      convsimArquivoNome.textContent = "Nenhum arquivo selecionado";
      return mostrarErroConvsim(data.error || "Falha ao enviar arquivo.");
    }
    convsimFileId = data.file_id;
    convsimColunasOrigem = data.colunas;
    convsimNomeBase = file.name.replace(/\.(xlsx|xls|csv)$/i, "");
    convsimArquivoNome.textContent = `${file.name} (${data.total_linhas} linha(s))`;
    renderConvsimMapaCampos();
    convsimSecaoMapeamento.classList.remove("hidden");
    btnConvsimMapear.disabled = false;
  } catch (err) {
    convsimArquivoNome.textContent = "Nenhum arquivo selecionado";
    mostrarErroConvsim(err.message || String(err));
  }
});

btnConvsimMapear.addEventListener("click", async () => {
  const mapping = {};
  convsimMapaCampos.querySelectorAll("select").forEach((sel) => {
    if (sel.value) mapping[sel.dataset.campo] = sel.value;
  });
  if (Object.keys(mapping).length === 0) {
    return mostrarErroConvsim("Mapeie ao menos uma coluna antes de continuar.");
  }
  btnConvsimMapear.disabled = true;
  btnConvsimMapear.textContent = "Aplicando...";
  try {
    const r = await fetch("/api/conversor-simcards/mapear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convsimFileId, mapping }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvsim(data.error || "Falha ao aplicar o mapeamento.");
    convsimRegistros = data.registros;
    convsimCamposMapeados = convsimCampos.filter((c) => mapping[c.chave]);
    convsimProblemasPorIndice = {};
    convsimDuplicadosPorIndice = {};
    convsimPagina = 1;
    convsimOrdenacao = null;
    convsimSecaoTrabalho.classList.remove("hidden");
    ajustarAlturaConvsimTabelaArea();
    renderConvsimTabelaCabecalho();
    renderConvsimTabela();
    await rodarValidacaoConvsim();

    const n = convsimCamposMapeados.length;
    convsimMapaResumoTexto.textContent = `${n} campo${n === 1 ? "" : "s"} mapeado${n === 1 ? "" : "s"}.`;
    convsimMapaDetalhe.classList.add("hidden");
    convsimMapaResumo.classList.remove("hidden");
  } catch (err) {
    mostrarErroConvsim(err.message || String(err));
  } finally {
    btnConvsimMapear.disabled = false;
    btnConvsimMapear.textContent = "Aplicar mapeamento";
  }
});

function convsimValorColuna(registro, chave) {
  if (chave === "indice") return registro.indice;
  if (chave === "problema") return convsimRegistroTemProblema(registro.indice) ? 1 : 0;
  return registro.dados[chave];
}

function ordenarConvsimRegistros(registros) {
  if (!convsimOrdenacao) return registros;
  const { chave, direcao } = convsimOrdenacao;
  return registros.slice().sort((a, b) => {
    const va = valorOrdenavel(convsimValorColuna(a, chave));
    const vb = valorOrdenavel(convsimValorColuna(b, chave));
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * direcao;
    return String(va).localeCompare(String(vb), "pt-BR", { numeric: true, sensitivity: "base" }) * direcao;
  });
}

function renderConvsimTabelaCabecalho() {
  convsimTabelaThead.innerHTML = "";
  const tr = document.createElement("tr");

  const criarThOrdenavel = (texto, chave, larguraPadrao) => {
    const th = document.createElement("th");
    th.className = "th-ordenavel";
    th.style.width = `${larguraPadrao}px`;
    th.textContent = texto;
    if (convsimOrdenacao && convsimOrdenacao.chave === chave) {
      const seta = document.createElement("span");
      seta.className = "seta-ordenacao";
      seta.textContent = convsimOrdenacao.direcao === 1 ? " ▲" : " ▼";
      th.appendChild(seta);
    }
    th.addEventListener("click", () => {
      const direcao = convsimOrdenacao && convsimOrdenacao.chave === chave ? -convsimOrdenacao.direcao : 1;
      convsimOrdenacao = { chave, direcao };
      convsimPagina = 1;
      renderConvsimTabelaCabecalho();
      renderConvsimTabela();
    });
    return th;
  };

  const thLinha = criarThOrdenavel("Linha", "indice", 52);
  thLinha.classList.add("convvei-th-linha");
  tr.appendChild(thLinha);
  const thProblema = criarThOrdenavel("Prob.", "problema", 40);
  thProblema.classList.add("convvei-th-problema");
  tr.appendChild(thProblema);

  convsimCamposMapeados.forEach((campo) => tr.appendChild(criarThOrdenavel(campo.rotulo, campo.chave, 180)));

  const thAcoes = document.createElement("th");
  thAcoes.style.width = "46px";
  thAcoes.textContent = "";
  tr.appendChild(thAcoes);

  convsimTabelaThead.appendChild(tr);
}

function convsimTotalPaginas() {
  return Math.max(1, Math.ceil(convsimRegistros.length / Number(convsimTamanhoPagina.value)));
}

function convsimProblemaCombinado(indice) {
  const a = convsimProblemasPorIndice[indice];
  const b = convsimDuplicadosPorIndice[indice];
  if (!a && !b) return null;
  return {
    erros: [...(a ? a.erros : []), ...(b ? b.erros : [])],
    avisos: [...(a ? a.avisos : []), ...(b ? b.avisos : [])],
  };
}

function convsimRegistroTemProblema(indice) {
  const p = convsimProblemaCombinado(indice);
  return !!(p && (p.erros.length > 0 || p.avisos.length > 0));
}

function montarLinhaConvsim(registro) {
  const tr = document.createElement("tr");
  tr.dataset.indice = registro.indice;
  const problema = convsimProblemaCombinado(registro.indice);

  const tdLinha = document.createElement("td");
  tdLinha.className = "convvei-td-linha";
  tdLinha.textContent = String(registro.indice);
  tr.appendChild(tdLinha);

  const tdProblema = document.createElement("td");
  tdProblema.className = "convvei-td-problema";
  let icone = "";
  if (problema && problema.erros.length > 0) {
    icone = "🔴";
    tr.classList.add("conversor-edicao-linha-erro");
  } else if (problema && problema.avisos.length > 0) {
    icone = "⚠️";
  } else if (problema) {
    icone = "✓";
  }
  tdProblema.textContent = icone;
  if (problema) {
    const msgs = [...problema.erros.map((e) => `⛔ ${e.mensagem}`), ...problema.avisos.map((a) => `⚠️ ${a.mensagem}`)];
    tr.title = msgs.join("\n");
    tdProblema.title = tr.title;
  }
  tr.appendChild(tdProblema);

  const duplicadosPorCampo = {};
  if (problema) {
    const todos = [...problema.erros, ...problema.avisos];
    todos.filter((p) => p.categoria === "duplicado_planilha").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
    todos.filter((p) => p.categoria === "duplicado_ssx").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
  }

  convsimCamposMapeados.forEach((campo) => {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.value = registro.dados[campo.chave] || "";
    const duplicado = duplicadosPorCampo[campo.rotulo];
    if (duplicado) {
      input.classList.add(duplicado.categoria === "duplicado_ssx" ? "convcli-campo-duplicado" : "convcli-campo-duplicado-planilha");
      input.title = duplicado.mensagem;
    }
    input.addEventListener("change", async () => {
      registro.dados[campo.chave] = input.value;
      try {
        const r = await fetch("/api/conversor-simcards/editar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: convsimFileId, indice: registro.indice, campo: campo.chave, valor: input.value }),
        });
        const data = await parseJsonResponse(r);
        if (!data.ok) return mostrarErroConvsim(data.error || "Falha ao salvar a edição.");
        await rodarValidacaoConvsim();
      } catch (err) {
        mostrarErroConvsim(err.message || String(err));
      }
    });
    td.appendChild(input);
    tr.appendChild(td);
  });

  const tdAcoes = document.createElement("td");
  tdAcoes.className = "convcli-td-acoes";
  const btnExcluir = document.createElement("button");
  btnExcluir.type = "button";
  btnExcluir.className = "btn-secondary convcli-btn-excluir-linha";
  btnExcluir.textContent = "🗑️";
  btnExcluir.title = "Excluir esta linha";
  btnExcluir.addEventListener("click", () => excluirLinhaConvsim(registro.indice));
  tdAcoes.appendChild(btnExcluir);
  tr.appendChild(tdAcoes);

  return tr;
}

function renderConvsimTabela() {
  const tamanho = Number(convsimTamanhoPagina.value);
  const registrosOrdenados = ordenarConvsimRegistros(convsimRegistros);
  convsimPagina = Math.min(Math.max(1, convsimPagina), convsimTotalPaginas());
  const inicio = (convsimPagina - 1) * tamanho;
  convsimTabelaTbody.innerHTML = "";
  registrosOrdenados.slice(inicio, inicio + tamanho).forEach((r) => convsimTabelaTbody.appendChild(montarLinhaConvsim(r)));
  tornarColunasRedimensionaveis(convsimTabelaElemento, CONVSIM_LARGURAS_KEY, { 0: 52, 1: 40 });

  convsimPaginacao.innerHTML = "";
  const total = convsimTotalPaginas();
  if (total > 1) {
    const anterior = document.createElement("button");
    anterior.type = "button";
    anterior.className = "btn-secondary";
    anterior.textContent = "‹ Anterior";
    anterior.disabled = convsimPagina === 1;
    anterior.addEventListener("click", () => { convsimPagina--; renderConvsimTabela(); });
    const info = document.createElement("span");
    info.textContent = `Página ${convsimPagina} de ${total}`;
    const proxima = document.createElement("button");
    proxima.type = "button";
    proxima.className = "btn-secondary";
    proxima.textContent = "Próxima ›";
    proxima.disabled = convsimPagina === total;
    proxima.addEventListener("click", () => { convsimPagina++; renderConvsimTabela(); });
    [anterior, info, proxima].forEach((n) => convsimPaginacao.appendChild(n));
  }
}
convsimTamanhoPagina.addEventListener("change", () => { convsimPagina = 1; renderConvsimTabela(); });

// --- EXCLUIR / ADICIONAR LINHA (Conversor de SIM Cards) ---
async function excluirLinhaConvsim(indice) {
  if (!convsimFileId) return;
  if (!confirm(`Excluir a linha ${indice}? Essa ação não pode ser desfeita.`)) return;
  try {
    const r = await fetch("/api/conversor-simcards/excluir-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convsimFileId, indice }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvsim(data.error || "Falha ao excluir a linha.");
    convsimRegistros = convsimRegistros.filter((r2) => r2.indice !== indice);
    delete convsimDuplicadosPorIndice[indice];
    await rodarValidacaoConvsim();
    mostrarInfoConvsim(`Linha ${indice} excluída.`);
  } catch (err) {
    mostrarErroConvsim(err.message || String(err));
  }
}

el("btn-convsim-adicionar-linha").addEventListener("click", async () => {
  if (!convsimFileId) return;
  try {
    const r = await fetch("/api/conversor-simcards/adicionar-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convsimFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvsim(data.error || "Falha ao adicionar a linha.");
    convsimRegistros.push(data.registro);
    convsimOrdenacao = null;
    renderConvsimTabelaCabecalho();
    convsimPagina = convsimTotalPaginas();
    await rodarValidacaoConvsim();
    mostrarInfoConvsim(`Linha ${data.registro.indice} adicionada — preencha os campos.`);
  } catch (err) {
    mostrarErroConvsim(err.message || String(err));
  }
});

el("btn-convsim-limpar-vazias").addEventListener("click", async () => {
  if (!convsimFileId) return;
  try {
    const r = await fetch("/api/conversor-simcards/limpar-vazias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convsimFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvsim(data.error || "Falha ao limpar as linhas vazias.");
    convsimRegistros = convsimRegistros.filter((reg) => Object.values(reg.dados).some((v) => (v || "").trim()));
    convsimPagina = 1;
    await rodarValidacaoConvsim();
    mostrarInfoConvsim(data.removidos ? `${data.removidos} linha(s) vazia(s) removida(s).` : "Nenhuma linha vazia encontrada.");
  } catch (err) {
    mostrarErroConvsim(err.message || String(err));
  }
});

async function rodarTransformacaoConvsim(acao, params, montarMensagem) {
  if (!convsimFileId) return;
  try {
    const r = await fetch("/api/conversor-simcards/transformar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convsimFileId, acao, params: params || {} }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvsim(data.error || "Falha ao aplicar a transformação.");
    const porIndice = new Map(data.registros.map((r2) => [r2.indice, r2]));
    convsimRegistros = convsimRegistros.map((r2) => porIndice.get(r2.indice) || r2);
    await rodarValidacaoConvsim();
    mostrarInfoConvsim(montarMensagem ? montarMensagem(data) : `${data.total_alterados} registro(s) alterado(s).`);
  } catch (err) {
    mostrarErroConvsim(err.message || String(err));
  }
}

el("btn-convsim-limpar-iccid").addEventListener("click", () =>
  rodarTransformacaoConvsim("limpar_campo", { campo: "iccid" }, (data) => `${data.ajustados} ICCID limpo(s).`));
el("btn-convsim-ajustar-telefone").addEventListener("click", () => {
  const dddPadrao = el("convsim-ddd-padrao").value.trim() || "55";
  rodarTransformacaoConvsim("ajustar_telefone", { ddd_padrao: dddPadrao }, (data) =>
    `${data.linhas_ajustadas} linha(s) com DDI/DDD do telefone ajustado(s).`);
});

function ligarBtnConvsimPreencherTodas(idBotao, idInput, campo, rotuloErro) {
  el(idBotao).addEventListener("click", () => {
    const valor = el(idInput).value.trim();
    if (!valor) return mostrarErroConvsim(`Informe ${rotuloErro} a ser preenchido.`);
    rodarTransformacaoConvsim("preencher_campo", { campo, valor }, (data) =>
      `${data.preenchidos} linha(s) preenchida(s) com "${valor}".`);
  });
}
ligarBtnConvsimPreencherTodas("btn-convsim-preencher-apn", "convsim-apn-valor", "apn_dominio", "o domínio da APN");
ligarBtnConvsimPreencherTodas("btn-convsim-preencher-corte", "convsim-corte-valor", "dia_corte", "o dia de corte");

function renderConvsimResumo(data) {
  convsimResumo.innerHTML = "";
  const tiles = document.createElement("div");
  tiles.className = "dashboard-tiles";
  [
    { valor: data.n_ok, label: "Válidos" },
    { valor: data.n_erro, label: "Com erro", clicavel: data.n_erro > 0 },
  ].forEach(({ valor, label, clicavel }) => {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const l = document.createElement("div");
    l.className = "stat-tile-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "stat-tile-valor";
    v.textContent = valor;
    tile.appendChild(l);
    tile.appendChild(v);
    if (clicavel) {
      tile.classList.add("stat-tile-clicavel");
      tile.title = "Ir para o primeiro registro com erro";
      tile.addEventListener("click", irParaPrimeiroErroConvsim);
    }
    tiles.appendChild(tile);
  });
  convsimResumo.appendChild(tiles);
  const legenda = document.createElement("p");
  legenda.className = "placeholder";
  legenda.textContent = `${data.n_ok} de ${data.total} registro(s) válidos para importar.`;
  convsimResumo.appendChild(legenda);
}

function irParaPrimeiroErroConvsim() {
  const ordenados = ordenarConvsimRegistros(convsimRegistros);
  const posicao = ordenados.findIndex((r) => {
    const p = convsimProblemaCombinado(r.indice);
    return p && p.erros.length > 0;
  });
  if (posicao === -1) return;

  const tamanho = Number(convsimTamanhoPagina.value);
  convsimPagina = Math.floor(posicao / tamanho) + 1;
  renderConvsimTabela();

  const indice = ordenados[posicao].indice;
  const tr = convsimTabelaTbody.querySelector(`tr[data-indice="${indice}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: "smooth", block: "center" });
  tr.classList.add("convcli-linha-destacada");
  setTimeout(() => tr.classList.remove("convcli-linha-destacada"), 2200);
}

async function rodarValidacaoConvsim() {
  if (!convsimFileId) return null;
  try {
    const r = await fetch("/api/conversor-simcards/validar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convsimFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvsim(data.error || "Falha ao validar.");
      return null;
    }
    convsimProblemasPorIndice = {};
    data.problemas.forEach((p) => { convsimProblemasPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvsimResumo(data);
    renderConvsimTabela();
    return data;
  } catch (err) {
    mostrarErroConvsim(err.message || String(err));
    return null;
  }
}
el("btn-convsim-validar").addEventListener("click", () => rodarValidacaoConvsim());

// --- VERIFICAR DUPLICIDADE NA SSX (Conversor de SIM Cards, opcional) ---
const overlayConvsimLogin = el("overlay-convsim-login");
const selectConvsimCredencial = el("convsim-select-credencial");

function renderSelectConvsimCredenciais() {
  selectConvsimCredencial.innerHTML = '<option value="">Login salvo...</option>';
  credenciaisCache.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.nome;
    selectConvsimCredencial.appendChild(opt);
  });
}

selectConvsimCredencial.addEventListener("change", () => {
  const cred = credenciaisCache.find((c) => c.id === selectConvsimCredencial.value);
  if (!cred) return;
  el("convsim-login").value = cred.login;
  el("convsim-senha").value = cred.senha;
  selectConvsimCredencial.value = "";
});

let convsimLoginAoEntrar = null;

el("convsim-login-fechar").addEventListener("click", () => {
  convsimLoginAoEntrar = null;
  overlayConvsimLogin.classList.add("hidden");
});

el("form-convsim-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const login = el("convsim-login").value.trim();
  const senha = el("convsim-senha").value;
  if (!login || !senha) return;
  const btn = el("btn-convsim-autenticar");
  btn.disabled = true;
  btn.textContent = "Entrando...";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, senha }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvsim(data.error || "Falha ao autenticar na SSX.");
      return;
    }
    convsimSsxOk = true;
    convsimSsxLogin = login;
    convsimSsxBase = extrairNomeBaseDeClaims(data.claims);
    convsimSsxClaimsRaw = data.claims || null;
    convsimAtualizarPillAuth();
    overlayConvsimLogin.classList.add("hidden");
    el("convsim-senha").value = "";
    const aoEntrar = convsimLoginAoEntrar;
    convsimLoginAoEntrar = null;
    if (aoEntrar) return await aoEntrar();
    await rodarVerificacaoDuplicidadeConvsim();
  } catch (err) {
    mostrarErroConvsim(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
});

el("btn-convsim-logout-ssx").addEventListener("click", async () => {
  await fetch("/api/logout-avulso", { method: "POST" });
  convsimSsxOk = false;
  convsimSsxLogin = "";
  convsimSsxBase = "";
  convsimSsxClaimsRaw = null;
  convsimAtualizarPillAuth();
  convsimDuplicadosPorIndice = {};
  renderConvsimTabela();
  mostrarInfoConvsim("Sessão da SSX encerrada.");
});

async function rodarVerificacaoDuplicidadeConvsim() {
  if (!convsimFileId) return null;
  const btn = el("btn-convsim-verificar-ssx");
  btn.disabled = true;
  btn.textContent = "Verificando...";
  try {
    const r = await fetch("/api/conversor-simcards/verificar-duplicidade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convsimFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (r.status === 401 || r.status === 409) {
        convsimSsxOk = false;
        convsimAtualizarPillAuth();
        renderSelectConvsimCredenciais();
        overlayConvsimLogin.classList.remove("hidden");
        return null;
      }
      mostrarErroConvsim(data.error || "Falha ao verificar duplicidade na SSX.");
      return null;
    }
    convsimDuplicadosPorIndice = {};
    data.problemas.forEach((p) => { convsimDuplicadosPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvsimTabela();
    mostrarInfoConvsim(
      data.total_duplicados
        ? `${data.total_duplicados} de ${data.total_verificados} registro(s) com ICCID já cadastrado na SSX.`
        : `Nenhum ICCID duplicado encontrado entre os ${data.total_verificados} registro(s) verificados.`
    );
    return data;
  } catch (err) {
    mostrarErroConvsim(err.message || String(err));
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = "Verificar na SSX";
  }
}

el("btn-convsim-verificar-ssx").addEventListener("click", () => {
  if (!convsimFileId) return;
  if (!convsimSsxOk) {
    convsimLoginAoEntrar = null;
    renderSelectConvsimCredenciais();
    overlayConvsimLogin.classList.remove("hidden");
    return;
  }
  rodarVerificacaoDuplicidadeConvsim();
});

function baixarConvsimArquivo(modo) {
  const a = document.createElement("a");
  a.href = `/api/conversor-simcards/exportar/${convsimFileId}/${modo}`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const overlayConvsimBaixarErro = el("overlay-convsim-baixar-erro");
const textoConvsimBaixarErro = el("convsim-baixar-erro-texto");
let resolverConvsimBaixarErro = null;
function fecharConvsimBaixarErro(escolha) {
  overlayConvsimBaixarErro.classList.add("hidden");
  const resolve = resolverConvsimBaixarErro;
  resolverConvsimBaixarErro = null;
  if (resolve) resolve(escolha);
}
function confirmarConvsimBaixarErro(nComErro) {
  const plural = nComErro === 1 ? "SIM card não passou" : "SIM cards não passaram";
  textoConvsimBaixarErro.textContent =
    `${nComErro} ${plural} na validação e podem ser rejeitados pelo SSX na importação. Baixe só os válidos, ou inclua os com erro pra corrigir depois.`;
  overlayConvsimBaixarErro.classList.remove("hidden");
  return new Promise((resolve) => { resolverConvsimBaixarErro = resolve; });
}
el("convsim-baixar-erro-fechar").addEventListener("click", () => fecharConvsimBaixarErro("cancelar"));
el("btn-convsim-baixar-erro-cancelar").addEventListener("click", () => fecharConvsimBaixarErro("cancelar"));
el("btn-convsim-baixar-com-erros").addEventListener("click", () => fecharConvsimBaixarErro("com-erros"));
el("btn-convsim-baixar-sem-erros").addEventListener("click", () => fecharConvsimBaixarErro("sem-erros"));

el("btn-convsim-baixar").addEventListener("click", async () => {
  if (!convsimFileId) return;
  const resultado = await rodarValidacaoConvsim();
  if (!resultado) return;
  if (resultado.n_erro > 0) {
    const escolha = await confirmarConvsimBaixarErro(resultado.n_erro);
    if (escolha === "cancelar") return;
    baixarConvsimArquivo(escolha === "com-erros" ? "todos" : "validos");
  } else {
    baixarConvsimArquivo("todos");
  }
});

el("btn-convsim-importar-api").addEventListener("click", () => {
  if (!convsimFileId) {
    return mostrarErroConvsim("Carregue e mapeie uma planilha no Conversor de SIM Cards antes.");
  }
  if (!convsimSsxOk) {
    convsimLoginAoEntrar = abrirModalImportDeConvsim;
    renderSelectConvsimCredenciais();
    overlayConvsimLogin.classList.remove("hidden");
    return;
  }
  abrirModalImportDeConvsim();
});

// --- CONVERSOR DE COLABORADORES -> SSX ---
// Sub-tela "/ferramentas/conversor-colaboradores": mesmo fluxo e mesmo
// molde das seções acima. Mesmo molde de "CONVERSOR DE RASTREADORES"
// (export .txt + Importar via API + duplicidade/referências combinadas num
// só "Verificar na SSX") — vários botões são diretamente análogos aos do
// Conversor de Clientes (Limpar CPF, Preencher senhas, Preencher pra todas
// as linhas), ver conversor_colaboradores.py.
const convcolInputArquivo = el("convcol-input-arquivo");
const convcolArquivoNome = el("convcol-arquivo-nome");
const convcolSecaoMapeamento = el("convcol-secao-mapeamento");
const convcolMapaCampos = el("convcol-mapa-campos");
const convcolMapaResumo = el("convcol-mapa-resumo");
const convcolMapaResumoTexto = el("convcol-mapa-resumo-texto");
const convcolMapaDetalhe = el("convcol-mapa-detalhe");
const btnConvcolMapear = el("btn-convcol-mapear");
const convcolSecaoTrabalho = el("convcol-secao-trabalho");
const convcolResumo = el("convcol-resumo");
const convcolTabelaThead = el("convcol-tabela-thead");
const convcolTabelaTbody = el("convcol-tabela-tbody");
const convcolTabelaElemento = convcolTabelaThead.closest("table");
const convcolTamanhoPagina = el("convcol-tamanho-pagina");
const convcolPaginacao = el("convcol-paginacao");
const convcolTabelaArea = el("convcol-tabela-area");
const CONVCOL_LARGURAS_KEY = "larguraColunas_convcolColaboradores";

function ajustarAlturaConvcolTabelaArea() {
  if (!convcolTabelaArea || !elConteudoPrincipal) return;
  convcolTabelaArea.style.height = `${elConteudoPrincipal.clientHeight - 24}px`;
}
if (elConteudoPrincipal && window.ResizeObserver) {
  new ResizeObserver(ajustarAlturaConvcolTabelaArea).observe(elConteudoPrincipal);
}
window.addEventListener("resize", ajustarAlturaConvcolTabelaArea);

let convcolFileId = null;
let convcolColunasOrigem = [];
let convcolCampos = [];
let convcolCamposMapeados = [];
let convcolRegistros = [];
let convcolProblemasPorIndice = {};
let convcolDuplicadosPorIndice = {};
let convcolNomeBase = "colaboradores";
let convcolPagina = 1;
let convcolOrdenacao = null;

let convcolSsxOk = false;
let convcolSsxLogin = "";
let convcolSsxBase = "";
let convcolSsxClaimsRaw = null;

function convcolAtualizarPillAuth() {
  const pill = el("convcol-status-auth");
  const btnLogout = el("btn-convcol-logout-ssx");
  if (convcolSsxOk) {
    pill.textContent = convcolSsxLogin
      ? `Autenticado na SSX (${convcolSsxLogin}${convcolSsxBase ? " — " + convcolSsxBase : ""})`
      : "Autenticado na SSX";
    pill.title = convcolSsxClaimsRaw ? JSON.stringify(convcolSsxClaimsRaw) : "";
    pill.className = "status-pill status-on";
    btnLogout.classList.remove("hidden");
  } else {
    pill.textContent = "Não autenticado na SSX";
    pill.className = "status-pill status-off";
    btnLogout.classList.add("hidden");
  }
}

function limparConvcol() {
  convcolFileId = null;
  convcolColunasOrigem = [];
  convcolCamposMapeados = [];
  convcolRegistros = [];
  convcolProblemasPorIndice = {};
  convcolDuplicadosPorIndice = {};
  convcolSsxOk = false;
  convcolSsxLogin = "";
  convcolSsxBase = "";
  convcolSsxClaimsRaw = null;
  convcolAtualizarPillAuth();
  convcolNomeBase = "colaboradores";
  convcolPagina = 1;
  convcolOrdenacao = null;
  convcolInputArquivo.value = "";
  convcolArquivoNome.textContent = "Nenhum arquivo selecionado";
  convcolSecaoMapeamento.classList.add("hidden");
  convcolSecaoTrabalho.classList.add("hidden");
  convcolMapaResumo.classList.add("hidden");
  convcolMapaDetalhe.classList.remove("hidden");
  convcolMapaCampos.innerHTML = "";
  convcolResumo.innerHTML = "";
  convcolTabelaThead.innerHTML = "";
  convcolTabelaTbody.innerHTML = "";
  convcolPaginacao.innerHTML = "";
  btnConvcolMapear.disabled = true;
}
limparConvcol();

function mostrarErroConvcol(msg) {
  convcolResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  convcolResumo.appendChild(p);
}

function mostrarInfoConvcol(msg) {
  convcolResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = msg;
  convcolResumo.appendChild(p);
}

async function carregarConvcolCampos() {
  if (convcolCampos.length) return convcolCampos;
  const r = await fetch("/api/conversor-colaboradores/campos");
  const data = await parseJsonResponse(r);
  if (!data.ok) throw new Error(data.error || "Falha ao carregar os campos da SSX.");
  convcolCampos = data.campos;
  return convcolCampos;
}

function renderConvcolMapaCampos() {
  convcolMapaCampos.innerHTML = "";
  convcolCampos.forEach((campo, i) => {
    const linha = document.createElement("div");
    linha.className = "convcli-mapa-linha";

    const nome = document.createElement("span");
    nome.className = "convcli-mapa-nome";
    const marca = campo.obrigatorio === true ? " *" : campo.obrigatorio === "condicional" ? " (condicional)" : "";
    nome.textContent = campo.rotulo + marca;
    nome.title = campo.rotulo + marca;

    const select = document.createElement("select");
    select.dataset.campo = campo.chave;
    const optVazio = document.createElement("option");
    optVazio.value = "";
    optVazio.textContent = "— não mapear —";
    select.appendChild(optVazio);
    convcolColunasOrigem.forEach((col) => {
      const opt = document.createElement("option");
      opt.value = col;
      opt.textContent = col;
      select.appendChild(opt);
    });
    if (convcolColunasOrigem[i] !== undefined) select.value = convcolColunasOrigem[i];

    linha.appendChild(nome);
    linha.appendChild(select);
    convcolMapaCampos.appendChild(linha);
  });
}

el("btn-convcol-mapear-limpar").addEventListener("click", () => {
  convcolMapaCampos.querySelectorAll("select").forEach((sel) => { sel.value = ""; });
});

el("btn-convcol-mapear-auto").addEventListener("click", () => {
  convcolMapaCampos.querySelectorAll("select").forEach((sel, i) => {
    sel.value = convcolColunasOrigem[i] !== undefined ? convcolColunasOrigem[i] : "";
  });
});

el("btn-convcol-mapa-editar").addEventListener("click", () => {
  convcolMapaResumo.classList.add("hidden");
  convcolMapaDetalhe.classList.remove("hidden");
});

convcolInputArquivo.addEventListener("change", async () => {
  const file = convcolInputArquivo.files[0];
  if (!file) return;
  convcolArquivoNome.textContent = "Enviando...";
  convcolSecaoTrabalho.classList.add("hidden");
  convcolSecaoMapeamento.classList.add("hidden");
  convcolSsxOk = false;
  convcolDuplicadosPorIndice = {};
  convcolAtualizarPillAuth();
  try {
    await carregarConvcolCampos();
    const formData = new FormData();
    formData.append("arquivo", file);
    const r = await fetch("/api/conversor-colaboradores/upload", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      convcolArquivoNome.textContent = "Nenhum arquivo selecionado";
      return mostrarErroConvcol(data.error || "Falha ao enviar arquivo.");
    }
    convcolFileId = data.file_id;
    convcolColunasOrigem = data.colunas;
    convcolNomeBase = file.name.replace(/\.(xlsx|xls|csv)$/i, "");
    convcolArquivoNome.textContent = `${file.name} (${data.total_linhas} linha(s))`;
    renderConvcolMapaCampos();
    convcolSecaoMapeamento.classList.remove("hidden");
    btnConvcolMapear.disabled = false;
  } catch (err) {
    convcolArquivoNome.textContent = "Nenhum arquivo selecionado";
    mostrarErroConvcol(err.message || String(err));
  }
});

btnConvcolMapear.addEventListener("click", async () => {
  const mapping = {};
  convcolMapaCampos.querySelectorAll("select").forEach((sel) => {
    if (sel.value) mapping[sel.dataset.campo] = sel.value;
  });
  if (Object.keys(mapping).length === 0) {
    return mostrarErroConvcol("Mapeie ao menos uma coluna antes de continuar.");
  }
  btnConvcolMapear.disabled = true;
  btnConvcolMapear.textContent = "Aplicando...";
  try {
    const r = await fetch("/api/conversor-colaboradores/mapear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcolFileId, mapping }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvcol(data.error || "Falha ao aplicar o mapeamento.");
    convcolRegistros = data.registros;
    convcolCamposMapeados = convcolCampos.filter((c) => mapping[c.chave]);
    convcolProblemasPorIndice = {};
    convcolDuplicadosPorIndice = {};
    convcolPagina = 1;
    convcolOrdenacao = null;
    convcolSecaoTrabalho.classList.remove("hidden");
    ajustarAlturaConvcolTabelaArea();
    renderConvcolTabelaCabecalho();
    renderConvcolTabela();
    await rodarValidacaoConvcol();

    const n = convcolCamposMapeados.length;
    convcolMapaResumoTexto.textContent = `${n} campo${n === 1 ? "" : "s"} mapeado${n === 1 ? "" : "s"}.`;
    convcolMapaDetalhe.classList.add("hidden");
    convcolMapaResumo.classList.remove("hidden");
  } catch (err) {
    mostrarErroConvcol(err.message || String(err));
  } finally {
    btnConvcolMapear.disabled = false;
    btnConvcolMapear.textContent = "Aplicar mapeamento";
  }
});

function convcolValorColuna(registro, chave) {
  if (chave === "indice") return registro.indice;
  if (chave === "problema") return convcolRegistroTemProblema(registro.indice) ? 1 : 0;
  return registro.dados[chave];
}

function ordenarConvcolRegistros(registros) {
  if (!convcolOrdenacao) return registros;
  const { chave, direcao } = convcolOrdenacao;
  return registros.slice().sort((a, b) => {
    const va = valorOrdenavel(convcolValorColuna(a, chave));
    const vb = valorOrdenavel(convcolValorColuna(b, chave));
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * direcao;
    return String(va).localeCompare(String(vb), "pt-BR", { numeric: true, sensitivity: "base" }) * direcao;
  });
}

function renderConvcolTabelaCabecalho() {
  convcolTabelaThead.innerHTML = "";
  const tr = document.createElement("tr");

  const criarThOrdenavel = (texto, chave, larguraPadrao) => {
    const th = document.createElement("th");
    th.className = "th-ordenavel";
    th.style.width = `${larguraPadrao}px`;
    th.textContent = texto;
    if (convcolOrdenacao && convcolOrdenacao.chave === chave) {
      const seta = document.createElement("span");
      seta.className = "seta-ordenacao";
      seta.textContent = convcolOrdenacao.direcao === 1 ? " ▲" : " ▼";
      th.appendChild(seta);
    }
    th.addEventListener("click", () => {
      const direcao = convcolOrdenacao && convcolOrdenacao.chave === chave ? -convcolOrdenacao.direcao : 1;
      convcolOrdenacao = { chave, direcao };
      convcolPagina = 1;
      renderConvcolTabelaCabecalho();
      renderConvcolTabela();
    });
    return th;
  };

  const thLinha = criarThOrdenavel("Linha", "indice", 52);
  thLinha.classList.add("convvei-th-linha");
  tr.appendChild(thLinha);
  const thProblema = criarThOrdenavel("Prob.", "problema", 40);
  thProblema.classList.add("convvei-th-problema");
  tr.appendChild(thProblema);

  convcolCamposMapeados.forEach((campo) => tr.appendChild(criarThOrdenavel(campo.rotulo, campo.chave, 180)));

  const thAcoes = document.createElement("th");
  thAcoes.style.width = "46px";
  thAcoes.textContent = "";
  tr.appendChild(thAcoes);

  convcolTabelaThead.appendChild(tr);
}

function convcolTotalPaginas() {
  return Math.max(1, Math.ceil(convcolRegistros.length / Number(convcolTamanhoPagina.value)));
}

function convcolProblemaCombinado(indice) {
  const a = convcolProblemasPorIndice[indice];
  const b = convcolDuplicadosPorIndice[indice];
  if (!a && !b) return null;
  return {
    erros: [...(a ? a.erros : []), ...(b ? b.erros : [])],
    avisos: [...(a ? a.avisos : []), ...(b ? b.avisos : [])],
  };
}

function convcolRegistroTemProblema(indice) {
  const p = convcolProblemaCombinado(indice);
  return !!(p && (p.erros.length > 0 || p.avisos.length > 0));
}

function montarLinhaConvcol(registro) {
  const tr = document.createElement("tr");
  tr.dataset.indice = registro.indice;
  const problema = convcolProblemaCombinado(registro.indice);

  const tdLinha = document.createElement("td");
  tdLinha.className = "convvei-td-linha";
  tdLinha.textContent = String(registro.indice);
  tr.appendChild(tdLinha);

  const tdProblema = document.createElement("td");
  tdProblema.className = "convvei-td-problema";
  let icone = "";
  if (problema && problema.erros.length > 0) {
    icone = "🔴";
    tr.classList.add("conversor-edicao-linha-erro");
  } else if (problema && problema.avisos.length > 0) {
    icone = "⚠️";
  } else if (problema) {
    icone = "✓";
  }
  tdProblema.textContent = icone;
  if (problema) {
    const msgs = [...problema.erros.map((e) => `⛔ ${e.mensagem}`), ...problema.avisos.map((a) => `⚠️ ${a.mensagem}`)];
    tr.title = msgs.join("\n");
    tdProblema.title = tr.title;
  }
  tr.appendChild(tdProblema);

  const duplicadosPorCampo = {};
  if (problema) {
    const todos = [...problema.erros, ...problema.avisos];
    todos.filter((p) => p.categoria === "duplicado_planilha").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
    todos.filter((p) => p.categoria === "duplicado_ssx" || p.categoria === "nao_cadastrado_ssx").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
  }

  convcolCamposMapeados.forEach((campo) => {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.value = registro.dados[campo.chave] || "";
    const duplicado = duplicadosPorCampo[campo.rotulo];
    if (duplicado) {
      input.classList.add((duplicado.categoria === "duplicado_ssx" || duplicado.categoria === "nao_cadastrado_ssx") ? "convcli-campo-duplicado" : "convcli-campo-duplicado-planilha");
      input.title = duplicado.mensagem;
    }
    input.addEventListener("change", async () => {
      registro.dados[campo.chave] = input.value;
      try {
        const r = await fetch("/api/conversor-colaboradores/editar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: convcolFileId, indice: registro.indice, campo: campo.chave, valor: input.value }),
        });
        const data = await parseJsonResponse(r);
        if (!data.ok) return mostrarErroConvcol(data.error || "Falha ao salvar a edição.");
        await rodarValidacaoConvcol();
      } catch (err) {
        mostrarErroConvcol(err.message || String(err));
      }
    });
    td.appendChild(input);
    tr.appendChild(td);
  });

  const tdAcoes = document.createElement("td");
  tdAcoes.className = "convcli-td-acoes";
  const btnExcluir = document.createElement("button");
  btnExcluir.type = "button";
  btnExcluir.className = "btn-secondary convcli-btn-excluir-linha";
  btnExcluir.textContent = "🗑️";
  btnExcluir.title = "Excluir esta linha";
  btnExcluir.addEventListener("click", () => excluirLinhaConvcol(registro.indice));
  tdAcoes.appendChild(btnExcluir);
  tr.appendChild(tdAcoes);

  return tr;
}

function renderConvcolTabela() {
  const tamanho = Number(convcolTamanhoPagina.value);
  const registrosOrdenados = ordenarConvcolRegistros(convcolRegistros);
  convcolPagina = Math.min(Math.max(1, convcolPagina), convcolTotalPaginas());
  const inicio = (convcolPagina - 1) * tamanho;
  convcolTabelaTbody.innerHTML = "";
  registrosOrdenados.slice(inicio, inicio + tamanho).forEach((r) => convcolTabelaTbody.appendChild(montarLinhaConvcol(r)));
  tornarColunasRedimensionaveis(convcolTabelaElemento, CONVCOL_LARGURAS_KEY, { 0: 52, 1: 40 });

  convcolPaginacao.innerHTML = "";
  const total = convcolTotalPaginas();
  if (total > 1) {
    const anterior = document.createElement("button");
    anterior.type = "button";
    anterior.className = "btn-secondary";
    anterior.textContent = "‹ Anterior";
    anterior.disabled = convcolPagina === 1;
    anterior.addEventListener("click", () => { convcolPagina--; renderConvcolTabela(); });
    const info = document.createElement("span");
    info.textContent = `Página ${convcolPagina} de ${total}`;
    const proxima = document.createElement("button");
    proxima.type = "button";
    proxima.className = "btn-secondary";
    proxima.textContent = "Próxima ›";
    proxima.disabled = convcolPagina === total;
    proxima.addEventListener("click", () => { convcolPagina++; renderConvcolTabela(); });
    [anterior, info, proxima].forEach((n) => convcolPaginacao.appendChild(n));
  }
}
convcolTamanhoPagina.addEventListener("change", () => { convcolPagina = 1; renderConvcolTabela(); });

// --- EXCLUIR / ADICIONAR LINHA (Conversor de Colaboradores) ---
async function excluirLinhaConvcol(indice) {
  if (!convcolFileId) return;
  if (!confirm(`Excluir a linha ${indice}? Essa ação não pode ser desfeita.`)) return;
  try {
    const r = await fetch("/api/conversor-colaboradores/excluir-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcolFileId, indice }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvcol(data.error || "Falha ao excluir a linha.");
    convcolRegistros = convcolRegistros.filter((r2) => r2.indice !== indice);
    delete convcolDuplicadosPorIndice[indice];
    await rodarValidacaoConvcol();
    mostrarInfoConvcol(`Linha ${indice} excluída.`);
  } catch (err) {
    mostrarErroConvcol(err.message || String(err));
  }
}

el("btn-convcol-adicionar-linha").addEventListener("click", async () => {
  if (!convcolFileId) return;
  try {
    const r = await fetch("/api/conversor-colaboradores/adicionar-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcolFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvcol(data.error || "Falha ao adicionar a linha.");
    convcolRegistros.push(data.registro);
    convcolOrdenacao = null;
    renderConvcolTabelaCabecalho();
    convcolPagina = convcolTotalPaginas();
    await rodarValidacaoConvcol();
    mostrarInfoConvcol(`Linha ${data.registro.indice} adicionada — preencha os campos.`);
  } catch (err) {
    mostrarErroConvcol(err.message || String(err));
  }
});

el("btn-convcol-limpar-vazias").addEventListener("click", async () => {
  if (!convcolFileId) return;
  try {
    const r = await fetch("/api/conversor-colaboradores/limpar-vazias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcolFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvcol(data.error || "Falha ao limpar as linhas vazias.");
    convcolRegistros = convcolRegistros.filter((reg) => Object.values(reg.dados).some((v) => (v || "").trim()));
    convcolPagina = 1;
    await rodarValidacaoConvcol();
    mostrarInfoConvcol(data.removidos ? `${data.removidos} linha(s) vazia(s) removida(s).` : "Nenhuma linha vazia encontrada.");
  } catch (err) {
    mostrarErroConvcol(err.message || String(err));
  }
});

async function rodarTransformacaoConvcol(acao, params, montarMensagem) {
  if (!convcolFileId) return;
  try {
    const r = await fetch("/api/conversor-colaboradores/transformar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcolFileId, acao, params: params || {} }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvcol(data.error || "Falha ao aplicar a transformação.");
    const porIndice = new Map(data.registros.map((r2) => [r2.indice, r2]));
    convcolRegistros = convcolRegistros.map((r2) => porIndice.get(r2.indice) || r2);
    await rodarValidacaoConvcol();
    mostrarInfoConvcol(montarMensagem ? montarMensagem(data) : `${data.total_alterados} registro(s) alterado(s).`);
  } catch (err) {
    mostrarErroConvcol(err.message || String(err));
  }
}

// Mesma ideia de conversor_clientes.limpar_cpf_cnpj (botão "Limpar
// CPF/CNPJ"), mas só CPF — backend não devolve contagem própria, mensagem
// padrão de rodarTransformacaoConvcol ("N registro(s) alterado(s).") já
// cobre, mesmo padrão de btn-convcli-limpar-docs.
el("btn-convcol-limpar-cpf").addEventListener("click", () => rodarTransformacaoConvcol("limpar_cpf"));

el("btn-convcol-ajustar-telefone").addEventListener("click", () => {
  const dddPadrao = el("convcol-ddd-padrao").value.trim() || "55";
  rodarTransformacaoConvcol("ajustar_telefone", { ddd_padrao: dddPadrao }, (data) =>
    `${data.linhas_ajustadas} linha(s) com DDI/DDD/Celular ajustado(s).`);
});

// Mesma ideia de conversor_clientes.preencher_senha (botão "Preencher
// senhas"): só preenche quem está vazio, a menos que "Sobrescrever" esteja
// marcado.
el("btn-convcol-preencher-senhas").addEventListener("click", () => {
  const senha = el("convcol-senha-padrao").value;
  const sobrescrever = el("convcol-senha-sobrescrever").checked;
  if (!senha) return mostrarErroConvcol("Informe a senha a ser preenchida.");
  rodarTransformacaoConvcol("preencher_senhas", { senha, sobrescrever }, (data) =>
    `${data.total_alterados} senha(s) preenchida(s).`);
});

// "Preencher pra todas as linhas" — mesmo handler genérico (acao
// "preencher_campo") reaproveitado pelos 3 botões, igual
// ligarBtnConvrstPreencherTodas.
function ligarBtnConvcolPreencherTodas(idBotao, idInput, campo, rotuloErro) {
  el(idBotao).addEventListener("click", () => {
    const valor = el(idInput).value.trim();
    if (!valor) return mostrarErroConvcol(`Informe ${rotuloErro} a ser preenchido.`);
    rodarTransformacaoConvcol("preencher_campo", { campo, valor }, (data) =>
      `${data.preenchidos} linha(s) preenchida(s) com "${valor}".`);
  });
}
ligarBtnConvcolPreencherTodas("btn-convcol-preencher-cargo", "convcol-cargo-valor", "cargo", "o cargo");
ligarBtnConvcolPreencherTodas("btn-convcol-preencher-perfil", "convcol-perfil-acesso-valor", "perfil_acesso", "o perfil de acesso");
ligarBtnConvcolPreencherTodas("btn-convcol-preencher-uo", "convcol-uo-valor", "unidade_organizacional", "a unidade organizacional");

function renderConvcolResumo(data) {
  convcolResumo.innerHTML = "";
  const tiles = document.createElement("div");
  tiles.className = "dashboard-tiles";
  [
    { valor: data.n_ok, label: "Válidos" },
    { valor: data.n_erro, label: "Com erro", clicavel: data.n_erro > 0 },
  ].forEach(({ valor, label, clicavel }) => {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const l = document.createElement("div");
    l.className = "stat-tile-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "stat-tile-valor";
    v.textContent = valor;
    tile.appendChild(l);
    tile.appendChild(v);
    if (clicavel) {
      tile.classList.add("stat-tile-clicavel");
      tile.title = "Ir para o primeiro registro com erro";
      tile.addEventListener("click", irParaPrimeiroErroConvcol);
    }
    tiles.appendChild(tile);
  });
  convcolResumo.appendChild(tiles);
  const legenda = document.createElement("p");
  legenda.className = "placeholder";
  legenda.textContent = `${data.n_ok} de ${data.total} registro(s) válidos para importar.`;
  convcolResumo.appendChild(legenda);
}

function irParaPrimeiroErroConvcol() {
  const ordenados = ordenarConvcolRegistros(convcolRegistros);
  const posicao = ordenados.findIndex((r) => {
    const p = convcolProblemaCombinado(r.indice);
    return p && p.erros.length > 0;
  });
  if (posicao === -1) return;

  const tamanho = Number(convcolTamanhoPagina.value);
  convcolPagina = Math.floor(posicao / tamanho) + 1;
  renderConvcolTabela();

  const indice = ordenados[posicao].indice;
  const tr = convcolTabelaTbody.querySelector(`tr[data-indice="${indice}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: "smooth", block: "center" });
  tr.classList.add("convcli-linha-destacada");
  setTimeout(() => tr.classList.remove("convcli-linha-destacada"), 2200);
}

async function rodarValidacaoConvcol() {
  if (!convcolFileId) return null;
  try {
    const r = await fetch("/api/conversor-colaboradores/validar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcolFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvcol(data.error || "Falha ao validar.");
      return null;
    }
    convcolProblemasPorIndice = {};
    data.problemas.forEach((p) => { convcolProblemasPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvcolResumo(data);
    renderConvcolTabela();
    return data;
  } catch (err) {
    mostrarErroConvcol(err.message || String(err));
    return null;
  }
}
el("btn-convcol-validar").addEventListener("click", () => rodarValidacaoConvcol());

// --- VERIFICAR DUPLICIDADE/REFERÊNCIAS NA SSX (Conversor de Colaboradores, opcional) ---
const overlayConvcolLogin = el("overlay-convcol-login");
const selectConvcolCredencial = el("convcol-select-credencial");

function renderSelectConvcolCredenciais() {
  selectConvcolCredencial.innerHTML = '<option value="">Login salvo...</option>';
  credenciaisCache.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.nome;
    selectConvcolCredencial.appendChild(opt);
  });
}

selectConvcolCredencial.addEventListener("change", () => {
  const cred = credenciaisCache.find((c) => c.id === selectConvcolCredencial.value);
  if (!cred) return;
  el("convcol-login").value = cred.login;
  el("convcol-senha").value = cred.senha;
  selectConvcolCredencial.value = "";
});

let convcolLoginAoEntrar = null;

el("convcol-login-fechar").addEventListener("click", () => {
  convcolLoginAoEntrar = null;
  overlayConvcolLogin.classList.add("hidden");
});

el("form-convcol-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const login = el("convcol-login").value.trim();
  const senha = el("convcol-senha").value;
  if (!login || !senha) return;
  const btn = el("btn-convcol-autenticar");
  btn.disabled = true;
  btn.textContent = "Entrando...";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, senha }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvcol(data.error || "Falha ao autenticar na SSX.");
      return;
    }
    convcolSsxOk = true;
    convcolSsxLogin = login;
    convcolSsxBase = extrairNomeBaseDeClaims(data.claims);
    convcolSsxClaimsRaw = data.claims || null;
    convcolAtualizarPillAuth();
    overlayConvcolLogin.classList.add("hidden");
    el("convcol-senha").value = "";
    const aoEntrar = convcolLoginAoEntrar;
    convcolLoginAoEntrar = null;
    if (aoEntrar) return await aoEntrar();
    await rodarVerificacaoDuplicidadeConvcol();
  } catch (err) {
    mostrarErroConvcol(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
});

el("btn-convcol-logout-ssx").addEventListener("click", async () => {
  await fetch("/api/logout-avulso", { method: "POST" });
  convcolSsxOk = false;
  convcolSsxLogin = "";
  convcolSsxBase = "";
  convcolSsxClaimsRaw = null;
  convcolAtualizarPillAuth();
  convcolDuplicadosPorIndice = {};
  renderConvcolTabela();
  mostrarInfoConvcol("Sessão da SSX encerrada.");
});

async function rodarVerificacaoDuplicidadeConvcol() {
  if (!convcolFileId) return null;
  const btn = el("btn-convcol-verificar-ssx");
  btn.disabled = true;
  btn.textContent = "Verificando...";
  try {
    const r = await fetch("/api/conversor-colaboradores/verificar-duplicidade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convcolFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (r.status === 401 || r.status === 409) {
        convcolSsxOk = false;
        convcolAtualizarPillAuth();
        renderSelectConvcolCredenciais();
        overlayConvcolLogin.classList.remove("hidden");
        return null;
      }
      mostrarErroConvcol(data.error || "Falha ao verificar na SSX.");
      return null;
    }
    convcolDuplicadosPorIndice = {};
    data.problemas.forEach((p) => { convcolDuplicadosPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvcolTabela();
    mostrarInfoConvcol(
      data.total_duplicados
        ? `${data.total_duplicados} de ${data.total_verificados} registro(s) com possível problema na SSX (duplicata de código/CPF/login, ou Unidade organizacional/Perfil de acesso não cadastrado).`
        : `Nenhum problema encontrado entre os ${data.total_verificados} registro(s) verificados (duplicata e referências na SSX).`
    );
    return data;
  } catch (err) {
    mostrarErroConvcol(err.message || String(err));
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = "Verificar na SSX";
  }
}

el("btn-convcol-verificar-ssx").addEventListener("click", () => {
  if (!convcolFileId) return;
  if (!convcolSsxOk) {
    convcolLoginAoEntrar = null;
    renderSelectConvcolCredenciais();
    overlayConvcolLogin.classList.remove("hidden");
    return;
  }
  rodarVerificacaoDuplicidadeConvcol();
});

function baixarConvcolArquivo(modo) {
  const a = document.createElement("a");
  a.href = `/api/conversor-colaboradores/exportar/${convcolFileId}/${modo}`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const overlayConvcolBaixarErro = el("overlay-convcol-baixar-erro");
const textoConvcolBaixarErro = el("convcol-baixar-erro-texto");
let resolverConvcolBaixarErro = null;
function fecharConvcolBaixarErro(escolha) {
  overlayConvcolBaixarErro.classList.add("hidden");
  const resolve = resolverConvcolBaixarErro;
  resolverConvcolBaixarErro = null;
  if (resolve) resolve(escolha);
}
function confirmarConvcolBaixarErro(nComErro) {
  const plural = nComErro === 1 ? "colaborador não passou" : "colaboradores não passaram";
  textoConvcolBaixarErro.textContent =
    `${nComErro} ${plural} na validação e podem ser rejeitados pelo SSX na importação. Baixe só os válidos, ou inclua os com erro pra corrigir depois.`;
  overlayConvcolBaixarErro.classList.remove("hidden");
  return new Promise((resolve) => { resolverConvcolBaixarErro = resolve; });
}
el("convcol-baixar-erro-fechar").addEventListener("click", () => fecharConvcolBaixarErro("cancelar"));
el("btn-convcol-baixar-erro-cancelar").addEventListener("click", () => fecharConvcolBaixarErro("cancelar"));
el("btn-convcol-baixar-com-erros").addEventListener("click", () => fecharConvcolBaixarErro("com-erros"));
el("btn-convcol-baixar-sem-erros").addEventListener("click", () => fecharConvcolBaixarErro("sem-erros"));

el("btn-convcol-baixar").addEventListener("click", async () => {
  if (!convcolFileId) return;
  const resultado = await rodarValidacaoConvcol();
  if (!resultado) return;
  if (resultado.n_erro > 0) {
    const escolha = await confirmarConvcolBaixarErro(resultado.n_erro);
    if (escolha === "cancelar") return;
    baixarConvcolArquivo(escolha === "com-erros" ? "todos" : "validos");
  } else {
    baixarConvcolArquivo("todos");
  }
});

el("btn-convcol-importar-api").addEventListener("click", () => {
  if (!convcolFileId) {
    return mostrarErroConvcol("Carregue e mapeie uma planilha no Conversor de Colaboradores antes.");
  }
  if (!convcolSsxOk) {
    convcolLoginAoEntrar = abrirModalImportDeConvcol;
    renderSelectConvcolCredenciais();
    overlayConvcolLogin.classList.remove("hidden");
    return;
  }
  abrirModalImportDeConvcol();
});

// --- OPERAÇÕES EM MASSA (Atalhos -> SSX) ---
// Sub-tela "/ferramentas/atalhos": ainda "em construção" (os 3 botões de
// ação continuam disabled), mas já com o login na SSX pronto, no mesmo
// padrão dos Conversores — flag de autenticação PRÓPRIA desta tela (nunca
// estado.autenticado de outra tela, ver gotcha nº1 do Conversor de
// Clientes), reseta sempre que a pessoa entra nesta tela de novo (mesma
// ideia de limparConvcli/limparConvcol, chamada no clique do card).
let atalhosSsxOk = false;
let atalhosSsxLogin = "";
let atalhosSsxBase = "";
let atalhosSsxClaimsRaw = null;
let atalhosExclusaoTipoAtual = "cliente";
let atalhosExclusaoRegistros = [];
let atalhosExclusaoSelecionados = new Set(); // códigos (únicos entre elegíveis)
let atalhosExclusaoOrdenacao = null; // {chave, direcao} | null
let atalhosExclusaoPollTimer = null;

function atalhosAtualizarPillAuth() {
  const pill = el("atalhos-status-auth");
  const btnLogout = el("btn-atalhos-logout-ssx");
  if (atalhosSsxOk) {
    pill.textContent = atalhosSsxLogin
      ? `Autenticado na SSX (${atalhosSsxLogin}${atalhosSsxBase ? " — " + atalhosSsxBase : ""})`
      : "Autenticado na SSX";
    pill.title = atalhosSsxClaimsRaw ? JSON.stringify(atalhosSsxClaimsRaw) : "";
    pill.className = "status-pill status-on";
    btnLogout.classList.remove("hidden");
  } else {
    pill.textContent = "Não autenticado na SSX";
    pill.className = "status-pill status-off";
    btnLogout.classList.add("hidden");
  }
}

function limparAtalhos() {
  atalhosSsxOk = false;
  atalhosSsxLogin = "";
  atalhosSsxBase = "";
  atalhosSsxClaimsRaw = null;
  atalhosAtualizarPillAuth();
  el("atalhos-exclusao-painel").classList.add("hidden");
  el("btn-atalhos-exclusao-massa").classList.remove("atalhos-operacao-card-ativo");
  atalhosExclusaoTipoAtual = "cliente";
  atalhosExclusaoRegistros = [];
  atalhosExclusaoSelecionados = new Set();
  atalhosExclusaoOrdenacao = null;
  const radioCliente = document.querySelector('input[name="atalhos-exclusao-tipo"][value="cliente"]');
  if (radioCliente) radioCliente.checked = true;
  const resultadoEl = el("atalhos-exclusao-resultado");
  if (resultadoEl) resultadoEl.innerHTML = '<p class="placeholder">Selecione um tipo de cadastro acima pra listar os registros da SSX.</p>';
  if (atalhosExclusaoPollTimer) {
    clearInterval(atalhosExclusaoPollTimer);
    atalhosExclusaoPollTimer = null;
  }
  el("overlay-atalhos-excluir").classList.add("hidden");
}
limparAtalhos();

const overlayAtalhosLogin = el("overlay-atalhos-login");
const selectAtalhosCredencial = el("atalhos-select-credencial");

function renderSelectAtalhosCredenciais() {
  selectAtalhosCredencial.innerHTML = '<option value="">Login salvo...</option>';
  credenciaisCache.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.nome;
    selectAtalhosCredencial.appendChild(opt);
  });
}

selectAtalhosCredencial.addEventListener("change", () => {
  const cred = credenciaisCache.find((c) => c.id === selectAtalhosCredencial.value);
  if (!cred) return;
  el("atalhos-login").value = cred.login;
  el("atalhos-senha").value = cred.senha;
  selectAtalhosCredencial.value = "";
});

// Callback setado antes de abrir o login, executado 1x depois de autenticar
// e resetado pra null em todo caminho que fecha/reabre o modal — mesmo
// padrão de convcliLoginAoEntrar (ver gotcha nº3 do Conversor de Clientes).
// Ainda sem nenhum botão de ação ligado (os 3 continuam disabled), mas já
// preparado pra quando entrarem em funcionamento.
let atalhosLoginAoEntrar = null;

el("atalhos-login-fechar").addEventListener("click", () => {
  atalhosLoginAoEntrar = null;
  overlayAtalhosLogin.classList.add("hidden");
});

el("form-atalhos-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const login = el("atalhos-login").value.trim();
  const senha = el("atalhos-senha").value;
  if (!login || !senha) return;
  const btn = el("btn-atalhos-autenticar");
  btn.disabled = true;
  btn.textContent = "Entrando...";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, senha }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      alert(data.error || "Falha ao autenticar na SSX.");
      return;
    }
    atalhosSsxOk = true;
    atalhosSsxLogin = login;
    atalhosSsxBase = extrairNomeBaseDeClaims(data.claims);
    atalhosSsxClaimsRaw = data.claims || null;
    atalhosAtualizarPillAuth();
    overlayAtalhosLogin.classList.add("hidden");
    el("atalhos-senha").value = "";
    const aoEntrar = atalhosLoginAoEntrar;
    atalhosLoginAoEntrar = null;
    if (aoEntrar) await aoEntrar();
  } catch (err) {
    alert(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
});

el("btn-atalhos-logout-ssx").addEventListener("click", async () => {
  await fetch("/api/logout-avulso", { method: "POST" });
  atalhosSsxOk = false;
  atalhosSsxLogin = "";
  atalhosSsxBase = "";
  atalhosSsxClaimsRaw = null;
  atalhosAtualizarPillAuth();
});

el("btn-atalhos-verificar-ssx").addEventListener("click", () => {
  if (atalhosSsxOk) return;
  atalhosLoginAoEntrar = null;
  renderSelectAtalhosCredenciais();
  overlayAtalhosLogin.classList.remove("hidden");
});

// Único dos 3 botões de operação já clicável — Associação/Desassociação
// continuam disabled ("Ainda não implementado"). "Excluir selecionados"
// também continua disabled de propósito: listar/selecionar já funciona de
// verdade (bate na SSX com o login desta tela), mas a exclusão em si é uma
// ação destrutiva e irreversível — fica pra um pedido explícito à parte.
const atalhosExclusaoPainel = el("atalhos-exclusao-painel");
const atalhosExclusaoResultado = el("atalhos-exclusao-resultado");

el("btn-atalhos-exclusao-massa").addEventListener("click", () => {
  const visivel = !atalhosExclusaoPainel.classList.contains("hidden");
  atalhosExclusaoPainel.classList.toggle("hidden", visivel);
  el("btn-atalhos-exclusao-massa").classList.toggle("atalhos-operacao-card-ativo", !visivel);
  if (!visivel) carregarAtalhosExclusao(atalhosExclusaoTipoAtual);
});

document.querySelectorAll('input[name="atalhos-exclusao-tipo"]').forEach((input) => {
  input.addEventListener("change", () => {
    atalhosExclusaoTipoAtual = input.value;
    carregarAtalhosExclusao(atalhosExclusaoTipoAtual);
  });
});

function mostrarInfoAtalhosExclusao(msg) {
  atalhosExclusaoResultado.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = msg;
  atalhosExclusaoResultado.appendChild(p);
}

function mostrarErroAtalhosExclusao(msg) {
  atalhosExclusaoResultado.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  atalhosExclusaoResultado.appendChild(p);
}

async function carregarAtalhosExclusao(tipo) {
  // "Áreas" não tem endpoint de consulta (List) na SSX — nem tenta bater na
  // API, mostra o aviso na hora (ver conversor_areas.py pro mesmo limite).
  if (tipo === "area") {
    atalhosExclusaoRegistros = [];
    atalhosExclusaoSelecionados = new Set();
    return mostrarInfoAtalhosExclusao(
      "Não é possível listar Áreas — a SSX não tem endpoint de consulta (List) pra esse cadastro, só Insert/Update/Delete."
    );
  }
  if (!atalhosSsxOk) {
    atalhosLoginAoEntrar = () => carregarAtalhosExclusao(tipo);
    renderSelectAtalhosCredenciais();
    overlayAtalhosLogin.classList.remove("hidden");
    return;
  }
  mostrarInfoAtalhosExclusao("Carregando...");
  try {
    const r = await fetch(`/api/atalhos/listar/${tipo}`, { method: "POST" });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (r.status === 401 || r.status === 409) {
        atalhosSsxOk = false;
        atalhosAtualizarPillAuth();
        atalhosLoginAoEntrar = () => carregarAtalhosExclusao(tipo);
        renderSelectAtalhosCredenciais();
        overlayAtalhosLogin.classList.remove("hidden");
        return;
      }
      return mostrarErroAtalhosExclusao(data.error || "Falha ao listar os registros.");
    }
    atalhosExclusaoRegistros = data.registros;
    atalhosExclusaoSelecionados = new Set();
    atalhosExclusaoOrdenacao = null;
    renderAtalhosExclusaoResultado();
  } catch (err) {
    mostrarErroAtalhosExclusao(err.message || String(err));
  }
}

function renderAtalhosExclusaoResultado() {
  atalhosExclusaoResultado.innerHTML = "";

  if (atalhosExclusaoRegistros.length === 0) {
    return mostrarInfoAtalhosExclusao("Nenhum registro encontrado na SSX pra esse tipo de cadastro.");
  }

  const elegiveis = atalhosExclusaoRegistros.filter((r) => r.elegivel);

  const toolbar = document.createElement("div");
  toolbar.className = "convcli-toolbar-validar";

  const btnSelecionar = document.createElement("button");
  btnSelecionar.type = "button";
  btnSelecionar.className = "btn-secondary";
  btnSelecionar.textContent = "Selecionar elegíveis";
  btnSelecionar.addEventListener("click", () => {
    atalhosExclusaoSelecionados = new Set(elegiveis.map((r) => r.codigo));
    renderAtalhosExclusaoResultado();
  });
  toolbar.appendChild(btnSelecionar);

  const btnDesmarcar = document.createElement("button");
  btnDesmarcar.type = "button";
  btnDesmarcar.className = "btn-secondary";
  btnDesmarcar.textContent = "Desmarcar todos";
  btnDesmarcar.addEventListener("click", () => {
    atalhosExclusaoSelecionados = new Set();
    renderAtalhosExclusaoResultado();
  });
  toolbar.appendChild(btnDesmarcar);

  const contador = document.createElement("span");
  contador.className = "status-pill " + (atalhosExclusaoSelecionados.size > 0 ? "status-on" : "status-off");
  contador.textContent = `${atalhosExclusaoSelecionados.size} selecionado(s)`;
  toolbar.appendChild(contador);

  atalhosExclusaoResultado.appendChild(toolbar);

  const legenda = document.createElement("p");
  legenda.className = "placeholder";
  legenda.textContent = `${atalhosExclusaoRegistros.length} registro(s) — ${elegiveis.length} elegível(eis), `
    + `${atalhosExclusaoRegistros.length - elegiveis.length} sem código de integração (não podem ser excluído(s) por esta operação).`;
  atalhosExclusaoResultado.appendChild(legenda);

  // Tabela com altura fixa e rolagem (não ocupa a tela inteira) — mesmo
  // padrão visual e de redimensão de coluna das planilhas dos Conversores
  // (.convcli-tabela/tornarColunasRedimensionaveis), só com um teto de
  // altura (.atalhos-exclusao-tabela-wrap) já que aqui é só mais um bloco
  // da página, não a tela toda.
  const wrap = document.createElement("div");
  wrap.className = "convcli-tabela-wrap atalhos-exclusao-tabela-wrap";
  const table = document.createElement("table");
  table.className = "tabela-saida convcli-tabela";

  const thead = document.createElement("thead");
  const trCabecalho = document.createElement("tr");
  const thCheck = document.createElement("th");
  thCheck.style.width = "36px";
  trCabecalho.appendChild(thCheck);

  const criarThOrdenavel = (texto, chave, larguraPadrao) => {
    const th = document.createElement("th");
    th.className = "th-ordenavel";
    th.style.width = `${larguraPadrao}px`;
    th.textContent = texto;
    if (atalhosExclusaoOrdenacao && atalhosExclusaoOrdenacao.chave === chave) {
      const seta = document.createElement("span");
      seta.className = "seta-ordenacao";
      seta.textContent = atalhosExclusaoOrdenacao.direcao === 1 ? " ▲" : " ▼";
      th.appendChild(seta);
    }
    th.addEventListener("click", () => {
      const direcao = atalhosExclusaoOrdenacao && atalhosExclusaoOrdenacao.chave === chave ? -atalhosExclusaoOrdenacao.direcao : 1;
      atalhosExclusaoOrdenacao = { chave, direcao };
      renderAtalhosExclusaoResultado();
    });
    return th;
  };
  trCabecalho.appendChild(criarThOrdenavel("Cadastro", "nome", 260));
  trCabecalho.appendChild(criarThOrdenavel("Código", "codigo", 200));
  thead.appendChild(trCabecalho);
  table.appendChild(thead);

  const registrosOrdenados = atalhosExclusaoOrdenacao
    ? ordenarLinhas(atalhosExclusaoRegistros, atalhosExclusaoOrdenacao.chave, atalhosExclusaoOrdenacao.direcao)
    : atalhosExclusaoRegistros;

  const tbody = document.createElement("tbody");
  registrosOrdenados.forEach((registro) => {
    const tr = document.createElement("tr");

    const tdCheck = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.disabled = !registro.elegivel;
    checkbox.checked = atalhosExclusaoSelecionados.has(registro.codigo);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) atalhosExclusaoSelecionados.add(registro.codigo);
      else atalhosExclusaoSelecionados.delete(registro.codigo);
      renderAtalhosExclusaoResultado();
    });
    tdCheck.appendChild(checkbox);
    tr.appendChild(tdCheck);

    const tdNome = document.createElement("td");
    tdNome.textContent = registro.nome;
    tr.appendChild(tdNome);

    const tdCodigo = document.createElement("td");
    if (registro.elegivel) {
      tdCodigo.textContent = registro.codigo;
    } else {
      tdCodigo.textContent = "⚠️ Sem código de integração";
      tdCodigo.title = "Não pode ser excluído por esta operação: a SSX exige código de integração pra excluir.";
      tdCodigo.style.color = "#b45309";
    }
    tr.appendChild(tdCodigo);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  atalhosExclusaoResultado.appendChild(wrap);
  tornarColunasRedimensionaveis(table, "larguraColunas_atalhosExclusao", { 0: 36 });

  const toolbarInferior = document.createElement("div");
  toolbarInferior.className = "convcli-toolbar-validar atalhos-exclusao-toolbar-inferior";
  const btnExcluir = document.createElement("button");
  btnExcluir.type = "button";
  btnExcluir.className = "btn-aviso-risco";
  btnExcluir.textContent = `Excluir selecionados (${atalhosExclusaoSelecionados.size})`;
  btnExcluir.disabled = atalhosExclusaoSelecionados.size === 0;
  btnExcluir.addEventListener("click", () => abrirModalAtalhosExcluir());
  toolbarInferior.appendChild(btnExcluir);
  atalhosExclusaoResultado.appendChild(toolbarInferior);
}

// --- EXECUTAR EXCLUSÃO EM MASSA (Atalhos) ---
// Modal de confirmação com resumo de quantos registros serão excluídos —
// o progresso e o log da API aparecem dentro desse MESMO modal depois que
// a pessoa confirma (não mais inline na página). Mesmo padrão de job/
// thread/polling de iniciarPollingDeletarVeiculos (Área de Importação):
// barra de progresso + log linha a linha, um código que falha não trava
// os demais.
const overlayAtalhosExcluir = el("overlay-atalhos-excluir");
const atalhosExcluirResumoTexto = el("atalhos-excluir-resumo-texto");
const atalhosExcluirProgresso = el("atalhos-excluir-progresso");
const atalhosExcluirBar = el("atalhos-excluir-bar");
const atalhosExcluirStatusEl = el("atalhos-excluir-status");
const atalhosExcluirPct = el("atalhos-excluir-pct");
const atalhosExcluirLog = el("atalhos-excluir-log");
const btnAtalhosExcluirConfirmar = el("btn-atalhos-excluir-confirmar");
const btnAtalhosExcluirCancelar = el("btn-atalhos-excluir-cancelar");
let atalhosExclusaoLogsMostrados = 0;

const ATALHOS_ROTULO_TIPO = { cliente: "cliente(s)", veiculo: "veículo(s)", rastreador: "rastreador(es)", simcard: "SIM card(s)" };

function abrirModalAtalhosExcluir() {
  const codigos = Array.from(atalhosExclusaoSelecionados);
  if (codigos.length === 0) return;
  const rotulo = ATALHOS_ROTULO_TIPO[atalhosExclusaoTipoAtual] || "registro(s)";
  atalhosExcluirResumoTexto.textContent =
    `Isso vai excluir permanentemente ${codigos.length} ${rotulo} da SSX. Essa ação NÃO pode ser desfeita.`;
  atalhosExcluirProgresso.classList.add("hidden");
  atalhosExcluirLog.innerHTML = "";
  btnAtalhosExcluirConfirmar.classList.remove("hidden");
  btnAtalhosExcluirConfirmar.disabled = false;
  btnAtalhosExcluirConfirmar.textContent = "Excluir";
  btnAtalhosExcluirCancelar.classList.remove("hidden");
  overlayAtalhosExcluir.classList.remove("hidden");
}

function fecharModalAtalhosExcluir() {
  overlayAtalhosExcluir.classList.add("hidden");
}
el("atalhos-excluir-fechar-x").addEventListener("click", fecharModalAtalhosExcluir);
btnAtalhosExcluirCancelar.addEventListener("click", fecharModalAtalhosExcluir);

function pararPollingAtalhosExclusao() {
  if (atalhosExclusaoPollTimer) {
    clearInterval(atalhosExclusaoPollTimer);
    atalhosExclusaoPollTimer = null;
  }
}

function iniciarPollingAtalhosExclusao(jobId) {
  atalhosExclusaoPollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/atalhos/excluir/status/${jobId}`);
      const job = await parseJsonResponse(r);
      if (!job.ok) {
        pararPollingAtalhosExclusao();
        return alert(`Erro ao consultar andamento: ${job.error || "falha desconhecida"}`);
      }

      const pct = job.total ? Math.min(Math.round((job.atual / job.total) * 100), 100) : 0;
      atalhosExcluirBar.style.width = pct + "%";
      atalhosExcluirPct.textContent = pct + "%";
      atalhosExcluirStatusEl.textContent = `${job.atual} de ${job.total} (sucessos: ${job.sucessos}, erros: ${job.erros})`;

      for (let i = atalhosExclusaoLogsMostrados; i < job.logs.length; i++) {
        const div = document.createElement("div");
        div.className = "log-linha";
        div.textContent = job.logs[i];
        atalhosExcluirLog.appendChild(div);
      }
      atalhosExclusaoLogsMostrados = job.logs.length;

      if (job.status === "concluido") {
        pararPollingAtalhosExclusao();
        const div = document.createElement("div");
        div.className = "resumo-final";
        div.textContent = `Concluído! Excluídos: ${job.sucessos} | Erros: ${job.erros}`;
        atalhosExcluirLog.appendChild(div);
        btnAtalhosExcluirConfirmar.classList.add("hidden");
        btnAtalhosExcluirCancelar.textContent = "Fechar";
        btnAtalhosExcluirCancelar.disabled = false;
        // Recarrega a lista — os excluídos com sucesso somem dela.
        carregarAtalhosExclusao(atalhosExclusaoTipoAtual);
      }
    } catch (err) {
      pararPollingAtalhosExclusao();
      alert(`Erro ao consultar andamento: ${String(err)}`);
    }
  }, 1500);
}

btnAtalhosExcluirConfirmar.addEventListener("click", async () => {
  const codigos = Array.from(atalhosExclusaoSelecionados);
  if (codigos.length === 0) return;

  btnAtalhosExcluirConfirmar.disabled = true;
  btnAtalhosExcluirCancelar.classList.add("hidden");
  atalhosExcluirProgresso.classList.remove("hidden");
  atalhosExcluirBar.style.width = "0%";
  atalhosExcluirPct.textContent = "0%";
  atalhosExcluirStatusEl.textContent = "Iniciando...";
  atalhosExcluirLog.innerHTML = "";
  atalhosExclusaoLogsMostrados = 0;

  try {
    const r = await fetch("/api/atalhos/excluir/executar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo: atalhosExclusaoTipoAtual, codigos }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) throw new Error(data.error || "Falha ao iniciar a exclusão em massa.");
    btnAtalhosExcluirConfirmar.classList.add("hidden");
    iniciarPollingAtalhosExclusao(data.job_id);
  } catch (err) {
    atalhosExcluirProgresso.classList.add("hidden");
    btnAtalhosExcluirConfirmar.classList.remove("hidden");
    btnAtalhosExcluirConfirmar.disabled = false;
    btnAtalhosExcluirCancelar.classList.remove("hidden");
    alert(`Erro: ${String(err)}`);
  }
});

// --- CONVERSOR DE UNIDADES ORGANIZACIONAIS -> SSX ---
// Sub-tela "/ferramentas/conversor-uo": mesmo fluxo e mesmo molde das
// seções acima. ÚNICO conversor sem "Baixar arquivo" — a SSX não tem
// layout de arquivo pra Unidade Organizacional (só
// `OrganizationalUnit/Insert`, confirmado no Swagger) — por isso não há
// overlay de "baixar com erro" nem função de exportar aqui, diferente de
// todos os outros 4 (ver conversor_uo.py).
const convuoInputArquivo = el("convuo-input-arquivo");
const convuoArquivoNome = el("convuo-arquivo-nome");
const convuoSecaoMapeamento = el("convuo-secao-mapeamento");
const convuoMapaCampos = el("convuo-mapa-campos");
const convuoMapaResumo = el("convuo-mapa-resumo");
const convuoMapaResumoTexto = el("convuo-mapa-resumo-texto");
const convuoMapaDetalhe = el("convuo-mapa-detalhe");
const btnConvuoMapear = el("btn-convuo-mapear");
const convuoSecaoTrabalho = el("convuo-secao-trabalho");
const convuoResumo = el("convuo-resumo");
const convuoTabelaThead = el("convuo-tabela-thead");
const convuoTabelaTbody = el("convuo-tabela-tbody");
const convuoTabelaElemento = convuoTabelaThead.closest("table");
const convuoTamanhoPagina = el("convuo-tamanho-pagina");
const convuoPaginacao = el("convuo-paginacao");
const convuoTabelaArea = el("convuo-tabela-area");
const CONVUO_LARGURAS_KEY = "larguraColunas_convuoUnidadesOrganizacionais";

function ajustarAlturaConvuoTabelaArea() {
  if (!convuoTabelaArea || !elConteudoPrincipal) return;
  convuoTabelaArea.style.height = `${elConteudoPrincipal.clientHeight - 24}px`;
}
if (elConteudoPrincipal && window.ResizeObserver) {
  new ResizeObserver(ajustarAlturaConvuoTabelaArea).observe(elConteudoPrincipal);
}
window.addEventListener("resize", ajustarAlturaConvuoTabelaArea);

let convuoFileId = null;
let convuoColunasOrigem = [];
let convuoCampos = [];
let convuoCamposMapeados = [];
let convuoRegistros = [];
let convuoProblemasPorIndice = {};
let convuoDuplicadosPorIndice = {};
let convuoNomeBase = "unidades_organizacionais";
let convuoPagina = 1;
let convuoOrdenacao = null;

let convuoSsxOk = false;
let convuoSsxLogin = "";
let convuoSsxBase = "";
let convuoSsxClaimsRaw = null;

function convuoAtualizarPillAuth() {
  const pill = el("convuo-status-auth");
  const btnLogout = el("btn-convuo-logout-ssx");
  if (convuoSsxOk) {
    pill.textContent = convuoSsxLogin
      ? `Autenticado na SSX (${convuoSsxLogin}${convuoSsxBase ? " — " + convuoSsxBase : ""})`
      : "Autenticado na SSX";
    pill.title = convuoSsxClaimsRaw ? JSON.stringify(convuoSsxClaimsRaw) : "";
    pill.className = "status-pill status-on";
    btnLogout.classList.remove("hidden");
  } else {
    pill.textContent = "Não autenticado na SSX";
    pill.className = "status-pill status-off";
    btnLogout.classList.add("hidden");
  }
}

function limparConvuo() {
  convuoFileId = null;
  convuoColunasOrigem = [];
  convuoCamposMapeados = [];
  convuoRegistros = [];
  convuoProblemasPorIndice = {};
  convuoDuplicadosPorIndice = {};
  convuoSsxOk = false;
  convuoSsxLogin = "";
  convuoSsxBase = "";
  convuoSsxClaimsRaw = null;
  convuoAtualizarPillAuth();
  convuoNomeBase = "unidades_organizacionais";
  convuoPagina = 1;
  convuoOrdenacao = null;
  convuoInputArquivo.value = "";
  convuoArquivoNome.textContent = "Nenhum arquivo selecionado";
  convuoSecaoMapeamento.classList.add("hidden");
  convuoSecaoTrabalho.classList.add("hidden");
  convuoMapaResumo.classList.add("hidden");
  convuoMapaDetalhe.classList.remove("hidden");
  convuoMapaCampos.innerHTML = "";
  convuoResumo.innerHTML = "";
  convuoTabelaThead.innerHTML = "";
  convuoTabelaTbody.innerHTML = "";
  convuoPaginacao.innerHTML = "";
  btnConvuoMapear.disabled = true;
}
limparConvuo();

function mostrarErroConvuo(msg) {
  convuoResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  convuoResumo.appendChild(p);
}

function mostrarInfoConvuo(msg) {
  convuoResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = msg;
  convuoResumo.appendChild(p);
}

async function carregarConvuoCampos() {
  if (convuoCampos.length) return convuoCampos;
  const r = await fetch("/api/conversor-uo/campos");
  const data = await parseJsonResponse(r);
  if (!data.ok) throw new Error(data.error || "Falha ao carregar os campos da SSX.");
  convuoCampos = data.campos;
  return convuoCampos;
}

function renderConvuoMapaCampos() {
  convuoMapaCampos.innerHTML = "";
  convuoCampos.forEach((campo, i) => {
    const linha = document.createElement("div");
    linha.className = "convcli-mapa-linha";

    const nome = document.createElement("span");
    nome.className = "convcli-mapa-nome";
    const marca = campo.obrigatorio === true ? " *" : campo.obrigatorio === "condicional" ? " (condicional)" : "";
    nome.textContent = campo.rotulo + marca;
    nome.title = campo.rotulo + marca;

    const select = document.createElement("select");
    select.dataset.campo = campo.chave;
    const optVazio = document.createElement("option");
    optVazio.value = "";
    optVazio.textContent = "— não mapear —";
    select.appendChild(optVazio);
    convuoColunasOrigem.forEach((col) => {
      const opt = document.createElement("option");
      opt.value = col;
      opt.textContent = col;
      select.appendChild(opt);
    });
    if (convuoColunasOrigem[i] !== undefined) select.value = convuoColunasOrigem[i];

    linha.appendChild(nome);
    linha.appendChild(select);
    convuoMapaCampos.appendChild(linha);
  });
}

el("btn-convuo-mapear-limpar").addEventListener("click", () => {
  convuoMapaCampos.querySelectorAll("select").forEach((sel) => { sel.value = ""; });
});

el("btn-convuo-mapear-auto").addEventListener("click", () => {
  convuoMapaCampos.querySelectorAll("select").forEach((sel, i) => {
    sel.value = convuoColunasOrigem[i] !== undefined ? convuoColunasOrigem[i] : "";
  });
});

el("btn-convuo-mapa-editar").addEventListener("click", () => {
  convuoMapaResumo.classList.add("hidden");
  convuoMapaDetalhe.classList.remove("hidden");
});

convuoInputArquivo.addEventListener("change", async () => {
  const file = convuoInputArquivo.files[0];
  if (!file) return;
  convuoArquivoNome.textContent = "Enviando...";
  convuoSecaoTrabalho.classList.add("hidden");
  convuoSecaoMapeamento.classList.add("hidden");
  convuoSsxOk = false;
  convuoDuplicadosPorIndice = {};
  convuoAtualizarPillAuth();
  try {
    await carregarConvuoCampos();
    const formData = new FormData();
    formData.append("arquivo", file);
    const r = await fetch("/api/conversor-uo/upload", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      convuoArquivoNome.textContent = "Nenhum arquivo selecionado";
      return mostrarErroConvuo(data.error || "Falha ao enviar arquivo.");
    }
    convuoFileId = data.file_id;
    convuoColunasOrigem = data.colunas;
    convuoNomeBase = file.name.replace(/\.(xlsx|xls|csv)$/i, "");
    convuoArquivoNome.textContent = `${file.name} (${data.total_linhas} linha(s))`;
    renderConvuoMapaCampos();
    convuoSecaoMapeamento.classList.remove("hidden");
    btnConvuoMapear.disabled = false;
  } catch (err) {
    convuoArquivoNome.textContent = "Nenhum arquivo selecionado";
    mostrarErroConvuo(err.message || String(err));
  }
});

btnConvuoMapear.addEventListener("click", async () => {
  const mapping = {};
  convuoMapaCampos.querySelectorAll("select").forEach((sel) => {
    if (sel.value) mapping[sel.dataset.campo] = sel.value;
  });
  if (Object.keys(mapping).length === 0) {
    return mostrarErroConvuo("Mapeie ao menos uma coluna antes de continuar.");
  }
  btnConvuoMapear.disabled = true;
  btnConvuoMapear.textContent = "Aplicando...";
  try {
    const r = await fetch("/api/conversor-uo/mapear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convuoFileId, mapping }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvuo(data.error || "Falha ao aplicar o mapeamento.");
    convuoRegistros = data.registros;
    convuoCamposMapeados = convuoCampos.filter((c) => mapping[c.chave]);
    convuoProblemasPorIndice = {};
    convuoDuplicadosPorIndice = {};
    convuoPagina = 1;
    convuoOrdenacao = null;
    convuoSecaoTrabalho.classList.remove("hidden");
    ajustarAlturaConvuoTabelaArea();
    renderConvuoTabelaCabecalho();
    renderConvuoTabela();
    await rodarValidacaoConvuo();

    const n = convuoCamposMapeados.length;
    convuoMapaResumoTexto.textContent = `${n} campo${n === 1 ? "" : "s"} mapeado${n === 1 ? "" : "s"}.`;
    convuoMapaDetalhe.classList.add("hidden");
    convuoMapaResumo.classList.remove("hidden");
  } catch (err) {
    mostrarErroConvuo(err.message || String(err));
  } finally {
    btnConvuoMapear.disabled = false;
    btnConvuoMapear.textContent = "Aplicar mapeamento";
  }
});

function convuoValorColuna(registro, chave) {
  if (chave === "indice") return registro.indice;
  if (chave === "problema") return convuoRegistroTemProblema(registro.indice) ? 1 : 0;
  return registro.dados[chave];
}

function ordenarConvuoRegistros(registros) {
  if (!convuoOrdenacao) return registros;
  const { chave, direcao } = convuoOrdenacao;
  return registros.slice().sort((a, b) => {
    const va = valorOrdenavel(convuoValorColuna(a, chave));
    const vb = valorOrdenavel(convuoValorColuna(b, chave));
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * direcao;
    return String(va).localeCompare(String(vb), "pt-BR", { numeric: true, sensitivity: "base" }) * direcao;
  });
}

function renderConvuoTabelaCabecalho() {
  convuoTabelaThead.innerHTML = "";
  const tr = document.createElement("tr");

  const criarThOrdenavel = (texto, chave, larguraPadrao) => {
    const th = document.createElement("th");
    th.className = "th-ordenavel";
    th.style.width = `${larguraPadrao}px`;
    th.textContent = texto;
    if (convuoOrdenacao && convuoOrdenacao.chave === chave) {
      const seta = document.createElement("span");
      seta.className = "seta-ordenacao";
      seta.textContent = convuoOrdenacao.direcao === 1 ? " ▲" : " ▼";
      th.appendChild(seta);
    }
    th.addEventListener("click", () => {
      const direcao = convuoOrdenacao && convuoOrdenacao.chave === chave ? -convuoOrdenacao.direcao : 1;
      convuoOrdenacao = { chave, direcao };
      convuoPagina = 1;
      renderConvuoTabelaCabecalho();
      renderConvuoTabela();
    });
    return th;
  };

  const thLinha = criarThOrdenavel("Linha", "indice", 52);
  thLinha.classList.add("convvei-th-linha");
  tr.appendChild(thLinha);
  const thProblema = criarThOrdenavel("Prob.", "problema", 40);
  thProblema.classList.add("convvei-th-problema");
  tr.appendChild(thProblema);

  convuoCamposMapeados.forEach((campo) => tr.appendChild(criarThOrdenavel(campo.rotulo, campo.chave, 180)));

  const thAcoes = document.createElement("th");
  thAcoes.style.width = "46px";
  thAcoes.textContent = "";
  tr.appendChild(thAcoes);

  convuoTabelaThead.appendChild(tr);
}

function convuoTotalPaginas() {
  return Math.max(1, Math.ceil(convuoRegistros.length / Number(convuoTamanhoPagina.value)));
}

function convuoProblemaCombinado(indice) {
  const a = convuoProblemasPorIndice[indice];
  const b = convuoDuplicadosPorIndice[indice];
  if (!a && !b) return null;
  return {
    erros: [...(a ? a.erros : []), ...(b ? b.erros : [])],
    avisos: [...(a ? a.avisos : []), ...(b ? b.avisos : [])],
  };
}

function convuoRegistroTemProblema(indice) {
  const p = convuoProblemaCombinado(indice);
  return !!(p && (p.erros.length > 0 || p.avisos.length > 0));
}

function montarLinhaConvuo(registro) {
  const tr = document.createElement("tr");
  tr.dataset.indice = registro.indice;
  const problema = convuoProblemaCombinado(registro.indice);

  const tdLinha = document.createElement("td");
  tdLinha.className = "convvei-td-linha";
  tdLinha.textContent = String(registro.indice);
  tr.appendChild(tdLinha);

  const tdProblema = document.createElement("td");
  tdProblema.className = "convvei-td-problema";
  let icone = "";
  if (problema && problema.erros.length > 0) {
    icone = "🔴";
    tr.classList.add("conversor-edicao-linha-erro");
  } else if (problema && problema.avisos.length > 0) {
    icone = "⚠️";
  } else if (problema) {
    icone = "✓";
  }
  tdProblema.textContent = icone;
  if (problema) {
    const msgs = [...problema.erros.map((e) => `⛔ ${e.mensagem}`), ...problema.avisos.map((a) => `⚠️ ${a.mensagem}`)];
    tr.title = msgs.join("\n");
    tdProblema.title = tr.title;
  }
  tr.appendChild(tdProblema);

  const duplicadosPorCampo = {};
  if (problema) {
    const todos = [...problema.erros, ...problema.avisos];
    todos.filter((p) => p.categoria === "duplicado_planilha").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
    todos.filter((p) => p.categoria === "duplicado_ssx").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
  }

  convuoCamposMapeados.forEach((campo) => {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.value = registro.dados[campo.chave] || "";
    const duplicado = duplicadosPorCampo[campo.rotulo];
    if (duplicado) {
      input.classList.add(duplicado.categoria === "duplicado_ssx" ? "convcli-campo-duplicado" : "convcli-campo-duplicado-planilha");
      input.title = duplicado.mensagem;
    }
    input.addEventListener("change", async () => {
      registro.dados[campo.chave] = input.value;
      try {
        const r = await fetch("/api/conversor-uo/editar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: convuoFileId, indice: registro.indice, campo: campo.chave, valor: input.value }),
        });
        const data = await parseJsonResponse(r);
        if (!data.ok) return mostrarErroConvuo(data.error || "Falha ao salvar a edição.");
        await rodarValidacaoConvuo();
      } catch (err) {
        mostrarErroConvuo(err.message || String(err));
      }
    });
    td.appendChild(input);
    tr.appendChild(td);
  });

  const tdAcoes = document.createElement("td");
  tdAcoes.className = "convcli-td-acoes";
  const btnExcluir = document.createElement("button");
  btnExcluir.type = "button";
  btnExcluir.className = "btn-secondary convcli-btn-excluir-linha";
  btnExcluir.textContent = "🗑️";
  btnExcluir.title = "Excluir esta linha";
  btnExcluir.addEventListener("click", () => excluirLinhaConvuo(registro.indice));
  tdAcoes.appendChild(btnExcluir);
  tr.appendChild(tdAcoes);

  return tr;
}

function renderConvuoTabela() {
  const tamanho = Number(convuoTamanhoPagina.value);
  const registrosOrdenados = ordenarConvuoRegistros(convuoRegistros);
  convuoPagina = Math.min(Math.max(1, convuoPagina), convuoTotalPaginas());
  const inicio = (convuoPagina - 1) * tamanho;
  convuoTabelaTbody.innerHTML = "";
  registrosOrdenados.slice(inicio, inicio + tamanho).forEach((r) => convuoTabelaTbody.appendChild(montarLinhaConvuo(r)));
  tornarColunasRedimensionaveis(convuoTabelaElemento, CONVUO_LARGURAS_KEY, { 0: 52, 1: 40 });

  convuoPaginacao.innerHTML = "";
  const total = convuoTotalPaginas();
  if (total > 1) {
    const anterior = document.createElement("button");
    anterior.type = "button";
    anterior.className = "btn-secondary";
    anterior.textContent = "‹ Anterior";
    anterior.disabled = convuoPagina === 1;
    anterior.addEventListener("click", () => { convuoPagina--; renderConvuoTabela(); });
    const info = document.createElement("span");
    info.textContent = `Página ${convuoPagina} de ${total}`;
    const proxima = document.createElement("button");
    proxima.type = "button";
    proxima.className = "btn-secondary";
    proxima.textContent = "Próxima ›";
    proxima.disabled = convuoPagina === total;
    proxima.addEventListener("click", () => { convuoPagina++; renderConvuoTabela(); });
    [anterior, info, proxima].forEach((n) => convuoPaginacao.appendChild(n));
  }
}
convuoTamanhoPagina.addEventListener("change", () => { convuoPagina = 1; renderConvuoTabela(); });

// --- EXCLUIR / ADICIONAR LINHA (Conversor de Unidades Organizacionais) ---
async function excluirLinhaConvuo(indice) {
  if (!convuoFileId) return;
  if (!confirm(`Excluir a linha ${indice}? Essa ação não pode ser desfeita.`)) return;
  try {
    const r = await fetch("/api/conversor-uo/excluir-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convuoFileId, indice }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvuo(data.error || "Falha ao excluir a linha.");
    convuoRegistros = convuoRegistros.filter((r2) => r2.indice !== indice);
    delete convuoDuplicadosPorIndice[indice];
    await rodarValidacaoConvuo();
    mostrarInfoConvuo(`Linha ${indice} excluída.`);
  } catch (err) {
    mostrarErroConvuo(err.message || String(err));
  }
}

el("btn-convuo-adicionar-linha").addEventListener("click", async () => {
  if (!convuoFileId) return;
  try {
    const r = await fetch("/api/conversor-uo/adicionar-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convuoFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvuo(data.error || "Falha ao adicionar a linha.");
    convuoRegistros.push(data.registro);
    convuoOrdenacao = null;
    renderConvuoTabelaCabecalho();
    convuoPagina = convuoTotalPaginas();
    await rodarValidacaoConvuo();
    mostrarInfoConvuo(`Linha ${data.registro.indice} adicionada — preencha os campos.`);
  } catch (err) {
    mostrarErroConvuo(err.message || String(err));
  }
});

el("btn-convuo-limpar-vazias").addEventListener("click", async () => {
  if (!convuoFileId) return;
  try {
    const r = await fetch("/api/conversor-uo/limpar-vazias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convuoFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvuo(data.error || "Falha ao limpar as linhas vazias.");
    convuoRegistros = convuoRegistros.filter((reg) => Object.values(reg.dados).some((v) => (v || "").trim()));
    convuoPagina = 1;
    await rodarValidacaoConvuo();
    mostrarInfoConvuo(data.removidos ? `${data.removidos} linha(s) vazia(s) removida(s).` : "Nenhuma linha vazia encontrada.");
  } catch (err) {
    mostrarErroConvuo(err.message || String(err));
  }
});

async function rodarTransformacaoConvuo(acao, params, montarMensagem) {
  if (!convuoFileId) return;
  try {
    const r = await fetch("/api/conversor-uo/transformar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convuoFileId, acao, params: params || {} }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvuo(data.error || "Falha ao aplicar a transformação.");
    const porIndice = new Map(data.registros.map((r2) => [r2.indice, r2]));
    convuoRegistros = convuoRegistros.map((r2) => porIndice.get(r2.indice) || r2);
    await rodarValidacaoConvuo();
    mostrarInfoConvuo(montarMensagem ? montarMensagem(data) : `${data.total_alterados} registro(s) alterado(s).`);
  } catch (err) {
    mostrarErroConvuo(err.message || String(err));
  }
}

function ligarBtnConvuoPreencherTodas(idBotao, idInput, campo, rotuloErro) {
  el(idBotao).addEventListener("click", () => {
    const valor = el(idInput).value.trim();
    if (!valor) return mostrarErroConvuo(`Informe ${rotuloErro} a ser preenchido.`);
    rodarTransformacaoConvuo("preencher_campo", { campo, valor }, (data) =>
      `${data.preenchidos} linha(s) preenchida(s) com "${valor}".`);
  });
}
ligarBtnConvuoPreencherTodas("btn-convuo-preencher-tipo", "convuo-tipo-valor", "tipo", "o tipo da Unidade Organizacional");
ligarBtnConvuoPreencherTodas("btn-convuo-preencher-cliente", "convuo-cliente-valor", "codigo_integracao_cliente", "o código de integração do cliente");
ligarBtnConvuoPreencherTodas("btn-convuo-preencher-pai", "convuo-pai-valor", "unidade_pai", "o código da Unidade Organizacional pai");

function renderConvuoResumo(data) {
  convuoResumo.innerHTML = "";
  const tiles = document.createElement("div");
  tiles.className = "dashboard-tiles";
  [
    { valor: data.n_ok, label: "Válidos" },
    { valor: data.n_erro, label: "Com erro", clicavel: data.n_erro > 0 },
  ].forEach(({ valor, label, clicavel }) => {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const l = document.createElement("div");
    l.className = "stat-tile-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "stat-tile-valor";
    v.textContent = valor;
    tile.appendChild(l);
    tile.appendChild(v);
    if (clicavel) {
      tile.classList.add("stat-tile-clicavel");
      tile.title = "Ir para o primeiro registro com erro";
      tile.addEventListener("click", irParaPrimeiroErroConvuo);
    }
    tiles.appendChild(tile);
  });
  convuoResumo.appendChild(tiles);
  const legenda = document.createElement("p");
  legenda.className = "placeholder";
  legenda.textContent = `${data.n_ok} de ${data.total} registro(s) válidos para importar.`;
  convuoResumo.appendChild(legenda);
}

function irParaPrimeiroErroConvuo() {
  const ordenados = ordenarConvuoRegistros(convuoRegistros);
  const posicao = ordenados.findIndex((r) => {
    const p = convuoProblemaCombinado(r.indice);
    return p && p.erros.length > 0;
  });
  if (posicao === -1) return;

  const tamanho = Number(convuoTamanhoPagina.value);
  convuoPagina = Math.floor(posicao / tamanho) + 1;
  renderConvuoTabela();

  const indice = ordenados[posicao].indice;
  const tr = convuoTabelaTbody.querySelector(`tr[data-indice="${indice}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: "smooth", block: "center" });
  tr.classList.add("convcli-linha-destacada");
  setTimeout(() => tr.classList.remove("convcli-linha-destacada"), 2200);
}

async function rodarValidacaoConvuo() {
  if (!convuoFileId) return null;
  try {
    const r = await fetch("/api/conversor-uo/validar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convuoFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvuo(data.error || "Falha ao validar.");
      return null;
    }
    convuoProblemasPorIndice = {};
    data.problemas.forEach((p) => { convuoProblemasPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvuoResumo(data);
    renderConvuoTabela();
    return data;
  } catch (err) {
    mostrarErroConvuo(err.message || String(err));
    return null;
  }
}
el("btn-convuo-validar").addEventListener("click", () => rodarValidacaoConvuo());

// --- VERIFICAR DUPLICIDADE/REFERÊNCIAS NA SSX (Conversor de Unidades Organizacionais, opcional) ---
const overlayConvuoLogin = el("overlay-convuo-login");
const selectConvuoCredencial = el("convuo-select-credencial");

function renderSelectConvuoCredenciais() {
  selectConvuoCredencial.innerHTML = '<option value="">Login salvo...</option>';
  credenciaisCache.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.nome;
    selectConvuoCredencial.appendChild(opt);
  });
}

selectConvuoCredencial.addEventListener("change", () => {
  const cred = credenciaisCache.find((c) => c.id === selectConvuoCredencial.value);
  if (!cred) return;
  el("convuo-login").value = cred.login;
  el("convuo-senha").value = cred.senha;
  selectConvuoCredencial.value = "";
});

let convuoLoginAoEntrar = null;

el("convuo-login-fechar").addEventListener("click", () => {
  convuoLoginAoEntrar = null;
  overlayConvuoLogin.classList.add("hidden");
});

el("form-convuo-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const login = el("convuo-login").value.trim();
  const senha = el("convuo-senha").value;
  if (!login || !senha) return;
  const btn = el("btn-convuo-autenticar");
  btn.disabled = true;
  btn.textContent = "Entrando...";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, senha }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvuo(data.error || "Falha ao autenticar na SSX.");
      return;
    }
    convuoSsxOk = true;
    convuoSsxLogin = login;
    convuoSsxBase = extrairNomeBaseDeClaims(data.claims);
    convuoSsxClaimsRaw = data.claims || null;
    convuoAtualizarPillAuth();
    overlayConvuoLogin.classList.add("hidden");
    el("convuo-senha").value = "";
    const aoEntrar = convuoLoginAoEntrar;
    convuoLoginAoEntrar = null;
    if (aoEntrar) return await aoEntrar();
    await rodarVerificacaoDuplicidadeConvuo();
  } catch (err) {
    mostrarErroConvuo(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
});

el("btn-convuo-logout-ssx").addEventListener("click", async () => {
  await fetch("/api/logout-avulso", { method: "POST" });
  convuoSsxOk = false;
  convuoSsxLogin = "";
  convuoSsxBase = "";
  convuoSsxClaimsRaw = null;
  convuoAtualizarPillAuth();
  convuoDuplicadosPorIndice = {};
  renderConvuoTabela();
  mostrarInfoConvuo("Sessão da SSX encerrada.");
});

async function rodarVerificacaoDuplicidadeConvuo() {
  if (!convuoFileId) return null;
  const btn = el("btn-convuo-verificar-ssx");
  btn.disabled = true;
  btn.textContent = "Verificando...";
  try {
    const r = await fetch("/api/conversor-uo/verificar-duplicidade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convuoFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (r.status === 401 || r.status === 409) {
        convuoSsxOk = false;
        convuoAtualizarPillAuth();
        renderSelectConvuoCredenciais();
        overlayConvuoLogin.classList.remove("hidden");
        return null;
      }
      mostrarErroConvuo(data.error || "Falha ao verificar na SSX.");
      return null;
    }
    convuoDuplicadosPorIndice = {};
    data.problemas.forEach((p) => { convuoDuplicadosPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvuoTabela();
    mostrarInfoConvuo(
      data.total_duplicados
        ? `${data.total_duplicados} de ${data.total_verificados} registro(s) com algum alerta (código já cadastrado, ou Unidade pai/Cliente não encontrados na SSX).`
        : `Nenhum alerta encontrado entre os ${data.total_verificados} registro(s) verificados.`
    );
    return data;
  } catch (err) {
    mostrarErroConvuo(err.message || String(err));
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = "Verificar na SSX";
  }
}

el("btn-convuo-verificar-ssx").addEventListener("click", () => {
  if (!convuoFileId) return;
  if (!convuoSsxOk) {
    convuoLoginAoEntrar = null;
    renderSelectConvuoCredenciais();
    overlayConvuoLogin.classList.remove("hidden");
    return;
  }
  rodarVerificacaoDuplicidadeConvuo();
});

el("btn-convuo-importar-api").addEventListener("click", () => {
  if (!convuoFileId) {
    return mostrarErroConvuo("Carregue e mapeie uma planilha no Conversor de Unidades Organizacionais antes.");
  }
  if (!convuoSsxOk) {
    convuoLoginAoEntrar = abrirModalImportDeConvuo;
    renderSelectConvuoCredenciais();
    overlayConvuoLogin.classList.remove("hidden");
    return;
  }
  abrirModalImportDeConvuo();
});

// --- CONVERSOR DE ÁREAS -> SSX ---
// Sub-tela "/ferramentas/conversor-areas": mesmo fluxo e mesmo molde das
// seções acima — caminho "via planilha" da importação de Áreas/Rotas/
// Pontos (complementa o Conversor KML -> SSX, 100% client-side, que cobre
// o caminho "via arquivo de mapa"). Não existe "Geography/List" no Swagger
// (só Insert/Update/Delete/ListCategories/ListGroups) — por isso
// "Verificar na SSX" só confere Categoria/Grupo (verificar_referencias_ssx),
// nunca duplicidade de área de verdade, e tem um botão extra
// "Categorias/Grupos" (mesmo padrão do botão "Templates" do Conversor de
// Rastreadores) pra conferir em lote o que falta cadastrar.
const convareInputArquivo = el("convare-input-arquivo");
const convareArquivoNome = el("convare-arquivo-nome");
const convareSecaoMapeamento = el("convare-secao-mapeamento");
const convareMapaCampos = el("convare-mapa-campos");
const convareMapaResumo = el("convare-mapa-resumo");
const convareMapaResumoTexto = el("convare-mapa-resumo-texto");
const convareMapaDetalhe = el("convare-mapa-detalhe");
const btnConvareMapear = el("btn-convare-mapear");
const convareSecaoTrabalho = el("convare-secao-trabalho");
const convareResumo = el("convare-resumo");
const convareTabelaThead = el("convare-tabela-thead");
const convareTabelaTbody = el("convare-tabela-tbody");
const convareTabelaElemento = convareTabelaThead.closest("table");
const convareTamanhoPagina = el("convare-tamanho-pagina");
const convarePaginacao = el("convare-paginacao");
const convareTabelaArea = el("convare-tabela-area");
const CONVARE_LARGURAS_KEY = "larguraColunas_convareAreas";

function ajustarAlturaConvareTabelaArea() {
  if (!convareTabelaArea || !elConteudoPrincipal) return;
  convareTabelaArea.style.height = `${elConteudoPrincipal.clientHeight - 24}px`;
}
if (elConteudoPrincipal && window.ResizeObserver) {
  new ResizeObserver(ajustarAlturaConvareTabelaArea).observe(elConteudoPrincipal);
}
window.addEventListener("resize", ajustarAlturaConvareTabelaArea);

let convareFileId = null;
let convareColunasOrigem = [];
let convareCampos = [];
let convareCamposMapeados = [];
let convareRegistros = [];
let convareProblemasPorIndice = {};
let convareReferenciasPorIndice = {};
let convareNomeBase = "areas";
let convarePagina = 1;
let convareOrdenacao = null;

let convareSsxOk = false;
let convareSsxLogin = "";
let convareSsxBase = "";
let convareSsxClaimsRaw = null;

function convareAtualizarPillAuth() {
  const pill = el("convare-status-auth");
  const btnLogout = el("btn-convare-logout-ssx");
  if (convareSsxOk) {
    pill.textContent = convareSsxLogin
      ? `Autenticado na SSX (${convareSsxLogin}${convareSsxBase ? " — " + convareSsxBase : ""})`
      : "Autenticado na SSX";
    pill.title = convareSsxClaimsRaw ? JSON.stringify(convareSsxClaimsRaw) : "";
    pill.className = "status-pill status-on";
    btnLogout.classList.remove("hidden");
  } else {
    pill.textContent = "Não autenticado na SSX";
    pill.className = "status-pill status-off";
    btnLogout.classList.add("hidden");
  }
}

function limparConvare() {
  convareFileId = null;
  convareColunasOrigem = [];
  convareCamposMapeados = [];
  convareRegistros = [];
  convareProblemasPorIndice = {};
  convareReferenciasPorIndice = {};
  convareSsxOk = false;
  convareSsxLogin = "";
  convareSsxBase = "";
  convareSsxClaimsRaw = null;
  convareAtualizarPillAuth();
  convareNomeBase = "areas";
  convarePagina = 1;
  convareOrdenacao = null;
  convareInputArquivo.value = "";
  convareArquivoNome.textContent = "Nenhum arquivo selecionado";
  convareSecaoMapeamento.classList.add("hidden");
  convareSecaoTrabalho.classList.add("hidden");
  convareMapaResumo.classList.add("hidden");
  convareMapaDetalhe.classList.remove("hidden");
  convareMapaCampos.innerHTML = "";
  convareResumo.innerHTML = "";
  convareTabelaThead.innerHTML = "";
  convareTabelaTbody.innerHTML = "";
  convarePaginacao.innerHTML = "";
  btnConvareMapear.disabled = true;
}
limparConvare();

function mostrarErroConvare(msg) {
  convareResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  convareResumo.appendChild(p);
}

function mostrarInfoConvare(msg) {
  convareResumo.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = msg;
  convareResumo.appendChild(p);
}

async function carregarConvareCampos() {
  if (convareCampos.length) return convareCampos;
  const r = await fetch("/api/conversor-areas/campos");
  const data = await parseJsonResponse(r);
  if (!data.ok) throw new Error(data.error || "Falha ao carregar os campos da SSX.");
  convareCampos = data.campos;
  return convareCampos;
}

function renderConvareMapaCampos() {
  convareMapaCampos.innerHTML = "";
  convareCampos.forEach((campo, i) => {
    const linha = document.createElement("div");
    linha.className = "convcli-mapa-linha";

    const nome = document.createElement("span");
    nome.className = "convcli-mapa-nome";
    const marca = campo.obrigatorio === true ? " *" : campo.obrigatorio === "condicional" ? " (condicional)" : "";
    nome.textContent = campo.rotulo + marca;
    nome.title = campo.rotulo + marca;

    const select = document.createElement("select");
    select.dataset.campo = campo.chave;
    const optVazio = document.createElement("option");
    optVazio.value = "";
    optVazio.textContent = "— não mapear —";
    select.appendChild(optVazio);
    convareColunasOrigem.forEach((col) => {
      const opt = document.createElement("option");
      opt.value = col;
      opt.textContent = col;
      select.appendChild(opt);
    });
    if (convareColunasOrigem[i] !== undefined) select.value = convareColunasOrigem[i];

    linha.appendChild(nome);
    linha.appendChild(select);
    convareMapaCampos.appendChild(linha);
  });
}

el("btn-convare-mapear-limpar").addEventListener("click", () => {
  convareMapaCampos.querySelectorAll("select").forEach((sel) => { sel.value = ""; });
});

el("btn-convare-mapear-auto").addEventListener("click", () => {
  convareMapaCampos.querySelectorAll("select").forEach((sel, i) => {
    sel.value = convareColunasOrigem[i] !== undefined ? convareColunasOrigem[i] : "";
  });
});

el("btn-convare-mapa-editar").addEventListener("click", () => {
  convareMapaResumo.classList.add("hidden");
  convareMapaDetalhe.classList.remove("hidden");
});

convareInputArquivo.addEventListener("change", async () => {
  const file = convareInputArquivo.files[0];
  if (!file) return;
  convareArquivoNome.textContent = "Enviando...";
  convareSecaoTrabalho.classList.add("hidden");
  convareSecaoMapeamento.classList.add("hidden");
  convareSsxOk = false;
  convareReferenciasPorIndice = {};
  convareAtualizarPillAuth();
  try {
    await carregarConvareCampos();
    const formData = new FormData();
    formData.append("arquivo", file);
    const r = await fetch("/api/conversor-areas/upload", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      convareArquivoNome.textContent = "Nenhum arquivo selecionado";
      return mostrarErroConvare(data.error || "Falha ao enviar arquivo.");
    }
    convareFileId = data.file_id;
    convareColunasOrigem = data.colunas;
    convareNomeBase = file.name.replace(/\.(xlsx|xls|csv)$/i, "");
    convareArquivoNome.textContent = `${file.name} (${data.total_linhas} linha(s))`;
    renderConvareMapaCampos();
    convareSecaoMapeamento.classList.remove("hidden");
    btnConvareMapear.disabled = false;
  } catch (err) {
    convareArquivoNome.textContent = "Nenhum arquivo selecionado";
    mostrarErroConvare(err.message || String(err));
  }
});

btnConvareMapear.addEventListener("click", async () => {
  const mapping = {};
  convareMapaCampos.querySelectorAll("select").forEach((sel) => {
    if (sel.value) mapping[sel.dataset.campo] = sel.value;
  });
  if (Object.keys(mapping).length === 0) {
    return mostrarErroConvare("Mapeie ao menos uma coluna antes de continuar.");
  }
  btnConvareMapear.disabled = true;
  btnConvareMapear.textContent = "Aplicando...";
  try {
    const r = await fetch("/api/conversor-areas/mapear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convareFileId, mapping }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvare(data.error || "Falha ao aplicar o mapeamento.");
    convareRegistros = data.registros;
    convareCamposMapeados = convareCampos.filter((c) => mapping[c.chave]);
    convareProblemasPorIndice = {};
    convareReferenciasPorIndice = {};
    convarePagina = 1;
    convareOrdenacao = null;
    convareSecaoTrabalho.classList.remove("hidden");
    ajustarAlturaConvareTabelaArea();
    renderConvareTabelaCabecalho();
    renderConvareTabela();
    await rodarValidacaoConvare();

    const n = convareCamposMapeados.length;
    convareMapaResumoTexto.textContent = `${n} campo${n === 1 ? "" : "s"} mapeado${n === 1 ? "" : "s"}.`;
    convareMapaDetalhe.classList.add("hidden");
    convareMapaResumo.classList.remove("hidden");
  } catch (err) {
    mostrarErroConvare(err.message || String(err));
  } finally {
    btnConvareMapear.disabled = false;
    btnConvareMapear.textContent = "Aplicar mapeamento";
  }
});

function convareValorColuna(registro, chave) {
  if (chave === "indice") return registro.indice;
  if (chave === "problema") return convareRegistroTemProblema(registro.indice) ? 1 : 0;
  return registro.dados[chave];
}

function ordenarConvareRegistros(registros) {
  if (!convareOrdenacao) return registros;
  const { chave, direcao } = convareOrdenacao;
  return registros.slice().sort((a, b) => {
    const va = valorOrdenavel(convareValorColuna(a, chave));
    const vb = valorOrdenavel(convareValorColuna(b, chave));
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * direcao;
    return String(va).localeCompare(String(vb), "pt-BR", { numeric: true, sensitivity: "base" }) * direcao;
  });
}

function renderConvareTabelaCabecalho() {
  convareTabelaThead.innerHTML = "";
  const tr = document.createElement("tr");

  const criarThOrdenavel = (texto, chave, larguraPadrao) => {
    const th = document.createElement("th");
    th.className = "th-ordenavel";
    th.style.width = `${larguraPadrao}px`;
    th.textContent = texto;
    if (convareOrdenacao && convareOrdenacao.chave === chave) {
      const seta = document.createElement("span");
      seta.className = "seta-ordenacao";
      seta.textContent = convareOrdenacao.direcao === 1 ? " ▲" : " ▼";
      th.appendChild(seta);
    }
    th.addEventListener("click", () => {
      const direcao = convareOrdenacao && convareOrdenacao.chave === chave ? -convareOrdenacao.direcao : 1;
      convareOrdenacao = { chave, direcao };
      convarePagina = 1;
      renderConvareTabelaCabecalho();
      renderConvareTabela();
    });
    return th;
  };

  const thLinha = criarThOrdenavel("Linha", "indice", 52);
  thLinha.classList.add("convvei-th-linha");
  tr.appendChild(thLinha);
  const thProblema = criarThOrdenavel("Prob.", "problema", 40);
  thProblema.classList.add("convvei-th-problema");
  tr.appendChild(thProblema);

  convareCamposMapeados.forEach((campo) => tr.appendChild(criarThOrdenavel(campo.rotulo, campo.chave, 180)));

  const thAcoes = document.createElement("th");
  thAcoes.style.width = "46px";
  thAcoes.textContent = "";
  tr.appendChild(thAcoes);

  convareTabelaThead.appendChild(tr);
}

function convareTotalPaginas() {
  return Math.max(1, Math.ceil(convareRegistros.length / Number(convareTamanhoPagina.value)));
}

function convareProblemaCombinado(indice) {
  const a = convareProblemasPorIndice[indice];
  const b = convareReferenciasPorIndice[indice];
  if (!a && !b) return null;
  return {
    erros: [...(a ? a.erros : []), ...(b ? b.erros : [])],
    avisos: [...(a ? a.avisos : []), ...(b ? b.avisos : [])],
  };
}

function convareRegistroTemProblema(indice) {
  const p = convareProblemaCombinado(indice);
  return !!(p && (p.erros.length > 0 || p.avisos.length > 0));
}

function montarLinhaConvare(registro) {
  const tr = document.createElement("tr");
  tr.dataset.indice = registro.indice;
  const problema = convareProblemaCombinado(registro.indice);

  const tdLinha = document.createElement("td");
  tdLinha.className = "convvei-td-linha";
  tdLinha.textContent = String(registro.indice);
  tr.appendChild(tdLinha);

  const tdProblema = document.createElement("td");
  tdProblema.className = "convvei-td-problema";
  let icone = "";
  if (problema && problema.erros.length > 0) {
    icone = "🔴";
    tr.classList.add("conversor-edicao-linha-erro");
  } else if (problema && problema.avisos.length > 0) {
    icone = "⚠️";
  } else if (problema) {
    icone = "✓";
  }
  tdProblema.textContent = icone;
  if (problema) {
    const msgs = [...problema.erros.map((e) => `⛔ ${e.mensagem}`), ...problema.avisos.map((a) => `⚠️ ${a.mensagem}`)];
    tr.title = msgs.join("\n");
    tdProblema.title = tr.title;
  }
  tr.appendChild(tdProblema);

  const duplicadosPorCampo = {};
  if (problema) {
    const todos = [...problema.erros, ...problema.avisos];
    todos.filter((p) => p.categoria === "duplicado_planilha").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
    todos.filter((p) => p.categoria === "duplicado_ssx" || p.categoria === "nao_cadastrado_ssx").forEach((p) => { duplicadosPorCampo[p.campo] = p; });
  }

  convareCamposMapeados.forEach((campo) => {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.value = registro.dados[campo.chave] || "";
    const duplicado = duplicadosPorCampo[campo.rotulo];
    if (duplicado) {
      input.classList.add((duplicado.categoria === "duplicado_ssx" || duplicado.categoria === "nao_cadastrado_ssx") ? "convcli-campo-duplicado" : "convcli-campo-duplicado-planilha");
      input.title = duplicado.mensagem;
    }
    input.addEventListener("change", async () => {
      registro.dados[campo.chave] = input.value;
      try {
        const r = await fetch("/api/conversor-areas/editar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: convareFileId, indice: registro.indice, campo: campo.chave, valor: input.value }),
        });
        const data = await parseJsonResponse(r);
        if (!data.ok) return mostrarErroConvare(data.error || "Falha ao salvar a edição.");
        await rodarValidacaoConvare();
      } catch (err) {
        mostrarErroConvare(err.message || String(err));
      }
    });
    td.appendChild(input);
    tr.appendChild(td);
  });

  const tdAcoes = document.createElement("td");
  tdAcoes.className = "convcli-td-acoes";
  const btnExcluir = document.createElement("button");
  btnExcluir.type = "button";
  btnExcluir.className = "btn-secondary convcli-btn-excluir-linha";
  btnExcluir.textContent = "🗑️";
  btnExcluir.title = "Excluir esta linha";
  btnExcluir.addEventListener("click", () => excluirLinhaConvare(registro.indice));
  tdAcoes.appendChild(btnExcluir);
  tr.appendChild(tdAcoes);

  return tr;
}

function renderConvareTabela() {
  const tamanho = Number(convareTamanhoPagina.value);
  const registrosOrdenados = ordenarConvareRegistros(convareRegistros);
  convarePagina = Math.min(Math.max(1, convarePagina), convareTotalPaginas());
  const inicio = (convarePagina - 1) * tamanho;
  convareTabelaTbody.innerHTML = "";
  registrosOrdenados.slice(inicio, inicio + tamanho).forEach((r) => convareTabelaTbody.appendChild(montarLinhaConvare(r)));
  tornarColunasRedimensionaveis(convareTabelaElemento, CONVARE_LARGURAS_KEY, { 0: 52, 1: 40 });

  convarePaginacao.innerHTML = "";
  const total = convareTotalPaginas();
  if (total > 1) {
    const anterior = document.createElement("button");
    anterior.type = "button";
    anterior.className = "btn-secondary";
    anterior.textContent = "‹ Anterior";
    anterior.disabled = convarePagina === 1;
    anterior.addEventListener("click", () => { convarePagina--; renderConvareTabela(); });
    const info = document.createElement("span");
    info.textContent = `Página ${convarePagina} de ${total}`;
    const proxima = document.createElement("button");
    proxima.type = "button";
    proxima.className = "btn-secondary";
    proxima.textContent = "Próxima ›";
    proxima.disabled = convarePagina === total;
    proxima.addEventListener("click", () => { convarePagina++; renderConvareTabela(); });
    [anterior, info, proxima].forEach((n) => convarePaginacao.appendChild(n));
  }
}
convareTamanhoPagina.addEventListener("change", () => { convarePagina = 1; renderConvareTabela(); });

// --- EXCLUIR / ADICIONAR LINHA (Conversor de Áreas) ---
async function excluirLinhaConvare(indice) {
  if (!convareFileId) return;
  if (!confirm(`Excluir a linha ${indice}? Essa ação não pode ser desfeita.`)) return;
  try {
    const r = await fetch("/api/conversor-areas/excluir-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convareFileId, indice }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvare(data.error || "Falha ao excluir a linha.");
    convareRegistros = convareRegistros.filter((r2) => r2.indice !== indice);
    delete convareReferenciasPorIndice[indice];
    await rodarValidacaoConvare();
    mostrarInfoConvare(`Linha ${indice} excluída.`);
  } catch (err) {
    mostrarErroConvare(err.message || String(err));
  }
}

el("btn-convare-adicionar-linha").addEventListener("click", async () => {
  if (!convareFileId) return;
  try {
    const r = await fetch("/api/conversor-areas/adicionar-linha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convareFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvare(data.error || "Falha ao adicionar a linha.");
    convareRegistros.push(data.registro);
    convareOrdenacao = null;
    renderConvareTabelaCabecalho();
    convarePagina = convareTotalPaginas();
    await rodarValidacaoConvare();
    mostrarInfoConvare(`Linha ${data.registro.indice} adicionada — preencha os campos.`);
  } catch (err) {
    mostrarErroConvare(err.message || String(err));
  }
});

el("btn-convare-limpar-vazias").addEventListener("click", async () => {
  if (!convareFileId) return;
  try {
    const r = await fetch("/api/conversor-areas/limpar-vazias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convareFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvare(data.error || "Falha ao limpar as linhas vazias.");
    convareRegistros = convareRegistros.filter((reg) => Object.values(reg.dados).some((v) => (v || "").trim()));
    convarePagina = 1;
    await rodarValidacaoConvare();
    mostrarInfoConvare(data.removidos ? `${data.removidos} linha(s) vazia(s) removida(s).` : "Nenhuma linha vazia encontrada.");
  } catch (err) {
    mostrarErroConvare(err.message || String(err));
  }
});

async function rodarTransformacaoConvare(acao, params, montarMensagem) {
  if (!convareFileId) return;
  try {
    const r = await fetch("/api/conversor-areas/transformar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convareFileId, acao, params: params || {} }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroConvare(data.error || "Falha ao aplicar a transformação.");
    const porIndice = new Map(data.registros.map((r2) => [r2.indice, r2]));
    convareRegistros = convareRegistros.map((r2) => porIndice.get(r2.indice) || r2);
    await rodarValidacaoConvare();
    mostrarInfoConvare(montarMensagem ? montarMensagem(data) : `${data.total_alterados} registro(s) alterado(s).`);
  } catch (err) {
    mostrarErroConvare(err.message || String(err));
  }
}

el("btn-convare-fechar-anel").addEventListener("click", () =>
  rodarTransformacaoConvare("fechar_anel", {}, (data) => `${data.fechados} área(s) com o anel fechado.`));

el("btn-convare-padronizar-coordenadas").addEventListener("click", () =>
  rodarTransformacaoConvare("padronizar_coordenadas", {}, (data) =>
    data.padronizados ? `${data.padronizados} linha(s) com coordenadas padronizadas.` : "Todas as coordenadas já estavam no formato padrão."));

el("btn-convare-inverter-latlong").addEventListener("click", () =>
  rodarTransformacaoConvare("inverter_lat_long", {}, (data) =>
    data.invertidos ? `${data.invertidos} linha(s) com a ordem das coordenadas invertida.` : "Nenhuma linha tinha coordenadas pra inverter."));

function ligarBtnConvarePreencherTodas(idBotao, idInput, campo, rotuloErro) {
  el(idBotao).addEventListener("click", () => {
    const valor = el(idInput).value.trim();
    if (!valor) return mostrarErroConvare(`Informe ${rotuloErro} a ser preenchido.`);
    rodarTransformacaoConvare("preencher_campo", { campo, valor }, (data) =>
      `${data.preenchidos} linha(s) preenchida(s) com "${valor}".`);
  });
}
ligarBtnConvarePreencherTodas("btn-convare-preencher-categoria", "convare-categoria-valor", "categoria", "a categoria");
ligarBtnConvarePreencherTodas("btn-convare-preencher-grupo", "convare-grupo-valor", "grupo", "o grupo");

// Tolerância: diferente dos outros preenchimentos em massa, valor vazio é
// uma ação válida (limpa a tolerância de todas as linhas) — pedido
// explícito, já que ela deixa de ser obrigatória quando o Tipo muda de
// Ponto pra Área/Rota.
el("btn-convare-preencher-tolerancia").addEventListener("click", () => {
  const valor = el("convare-tolerancia-valor").value.trim();
  rodarTransformacaoConvare("preencher_campo", { campo: "tolerancia", valor }, (data) =>
    valor ? `${data.preenchidos} linha(s) preenchida(s) com tolerância "${valor}".` : `${data.preenchidos} linha(s) com a tolerância limpa.`);
});

// Cor: escala de cores (CORES_SSX, mesma tabela do manual já usada pelo
// Conversor KML e pelo "Cor do ícone" de Veículos) em vez de pedir pra
// digitar o número de cabeça — mesmo componente visual
// (".conversor-cor-mini-grupo"/".conversor-cor-mini") usado nos dois,
// aqui pra escolher UM valor que vale pra toda a planilha ao clicar
// "Preencher todas" (não por linha).
let convareCorSelecionada = null;
const convareCorSwatches = el("convare-cor-swatches");

function renderConvareCorSwatches() {
  convareCorSwatches.innerHTML = "";
  CORES_SSX.forEach(({ codigo, hex }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "conversor-cor-mini";
    btn.style.background = hex;
    btn.title = `Código ${codigo} (${hex})`;
    btn.textContent = String(codigo);
    if (convareCorSelecionada === codigo) btn.classList.add("selecionada");
    btn.addEventListener("click", () => {
      convareCorSelecionada = convareCorSelecionada === codigo ? null : codigo;
      renderConvareCorSwatches();
    });
    convareCorSwatches.appendChild(btn);
  });
}
renderConvareCorSwatches();

el("btn-convare-preencher-cor").addEventListener("click", () => {
  if (!convareCorSelecionada) return mostrarErroConvare("Selecione uma cor na escala antes de preencher.");
  const valor = String(convareCorSelecionada);
  rodarTransformacaoConvare("preencher_campo", { campo: "cor", valor }, (data) =>
    `${data.preenchidos} linha(s) preenchida(s) com a cor ${valor}.`);
});

function renderConvareResumo(data) {
  convareResumo.innerHTML = "";
  const tiles = document.createElement("div");
  tiles.className = "dashboard-tiles";
  [
    { valor: data.n_ok, label: "Válidos" },
    { valor: data.n_erro, label: "Com erro", clicavel: data.n_erro > 0 },
  ].forEach(({ valor, label, clicavel }) => {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const l = document.createElement("div");
    l.className = "stat-tile-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "stat-tile-valor";
    v.textContent = valor;
    tile.appendChild(l);
    tile.appendChild(v);
    if (clicavel) {
      tile.classList.add("stat-tile-clicavel");
      tile.title = "Ir para o primeiro registro com erro";
      tile.addEventListener("click", irParaPrimeiroErroConvare);
    }
    tiles.appendChild(tile);
  });
  convareResumo.appendChild(tiles);
  const legenda = document.createElement("p");
  legenda.className = "placeholder";
  legenda.textContent = `${data.n_ok} de ${data.total} registro(s) válidos para importar.`;
  convareResumo.appendChild(legenda);
}

function irParaPrimeiroErroConvare() {
  const ordenados = ordenarConvareRegistros(convareRegistros);
  const posicao = ordenados.findIndex((r) => {
    const p = convareProblemaCombinado(r.indice);
    return p && p.erros.length > 0;
  });
  if (posicao === -1) return;

  const tamanho = Number(convareTamanhoPagina.value);
  convarePagina = Math.floor(posicao / tamanho) + 1;
  renderConvareTabela();

  const indice = ordenados[posicao].indice;
  const tr = convareTabelaTbody.querySelector(`tr[data-indice="${indice}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: "smooth", block: "center" });
  tr.classList.add("convcli-linha-destacada");
  setTimeout(() => tr.classList.remove("convcli-linha-destacada"), 2200);
}

async function rodarValidacaoConvare() {
  if (!convareFileId) return null;
  try {
    const r = await fetch("/api/conversor-areas/validar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convareFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvare(data.error || "Falha ao validar.");
      return null;
    }
    convareProblemasPorIndice = {};
    data.problemas.forEach((p) => { convareProblemasPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvareResumo(data);
    renderConvareTabela();
    return data;
  } catch (err) {
    mostrarErroConvare(err.message || String(err));
    return null;
  }
}
el("btn-convare-validar").addEventListener("click", () => rodarValidacaoConvare());

// --- VERIFICAR REFERÊNCIAS NA SSX (Conversor de Áreas, opcional) ---
const overlayConvareLogin = el("overlay-convare-login");
const selectConvareCredencial = el("convare-select-credencial");

function renderSelectConvareCredenciais() {
  selectConvareCredencial.innerHTML = '<option value="">Login salvo...</option>';
  credenciaisCache.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.nome;
    selectConvareCredencial.appendChild(opt);
  });
}

selectConvareCredencial.addEventListener("change", () => {
  const cred = credenciaisCache.find((c) => c.id === selectConvareCredencial.value);
  if (!cred) return;
  el("convare-login").value = cred.login;
  el("convare-senha").value = cred.senha;
  selectConvareCredencial.value = "";
});

let convareLoginAoEntrar = null;

el("convare-login-fechar").addEventListener("click", () => {
  convareLoginAoEntrar = null;
  overlayConvareLogin.classList.add("hidden");
});

el("form-convare-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const login = el("convare-login").value.trim();
  const senha = el("convare-senha").value;
  if (!login || !senha) return;
  const btn = el("btn-convare-autenticar");
  btn.disabled = true;
  btn.textContent = "Entrando...";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, senha }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConvare(data.error || "Falha ao autenticar na SSX.");
      return;
    }
    convareSsxOk = true;
    convareSsxLogin = login;
    convareSsxBase = extrairNomeBaseDeClaims(data.claims);
    convareSsxClaimsRaw = data.claims || null;
    convareAtualizarPillAuth();
    overlayConvareLogin.classList.add("hidden");
    el("convare-senha").value = "";
    const aoEntrar = convareLoginAoEntrar;
    convareLoginAoEntrar = null;
    if (aoEntrar) return await aoEntrar();
    await rodarVerificacaoReferenciasConvare();
  } catch (err) {
    mostrarErroConvare(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
});

el("btn-convare-logout-ssx").addEventListener("click", async () => {
  await fetch("/api/logout-avulso", { method: "POST" });
  convareSsxOk = false;
  convareSsxLogin = "";
  convareSsxBase = "";
  convareSsxClaimsRaw = null;
  convareAtualizarPillAuth();
  convareReferenciasPorIndice = {};
  renderConvareTabela();
  mostrarInfoConvare("Sessão da SSX encerrada.");
});

async function rodarVerificacaoReferenciasConvare() {
  if (!convareFileId) return null;
  const btn = el("btn-convare-verificar-ssx");
  btn.disabled = true;
  btn.textContent = "Verificando...";
  try {
    const r = await fetch("/api/conversor-areas/verificar-duplicidade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convareFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (r.status === 401 || r.status === 409) {
        convareSsxOk = false;
        convareAtualizarPillAuth();
        renderSelectConvareCredenciais();
        overlayConvareLogin.classList.remove("hidden");
        return null;
      }
      mostrarErroConvare(data.error || "Falha ao verificar referências na SSX.");
      return null;
    }
    convareReferenciasPorIndice = {};
    data.problemas.forEach((p) => { convareReferenciasPorIndice[p.indice] = { erros: p.erros, avisos: p.avisos }; });
    renderConvareTabela();
    mostrarInfoConvare(
      data.total_duplicados
        ? `${data.total_duplicados} de ${data.total_verificados} registro(s) com Categoria/Grupo ainda não cadastrado na SSX.`
        : `Categoria e Grupo de todos os ${data.total_verificados} registro(s) já estão cadastrados na SSX.`
    );
    return data;
  } catch (err) {
    mostrarErroConvare(err.message || String(err));
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = "Verificar na SSX";
  }
}

el("btn-convare-verificar-ssx").addEventListener("click", () => {
  if (!convareFileId) return;
  if (!convareSsxOk) {
    convareLoginAoEntrar = null;
    renderSelectConvareCredenciais();
    overlayConvareLogin.classList.remove("hidden");
    return;
  }
  rodarVerificacaoReferenciasConvare();
});

// Botão "Categorias/Grupos": checklist do que a planilha usa — mesmo
// padrão do botão "Templates" do Conversor de Rastreadores. Aparece
// sempre, direto de convareRegistros (já em memória), sem exigir login; a
// checagem de quem já está cadastrado na SSX é um passo à parte, opcional
// (mesma sessão/login de "Verificar na SSX" — convareSsxOk/convareLoginAoEntrar).
const overlayConvareCategorias = el("overlay-convare-categorias");
const convareCategoriasListaCategorias = el("convare-categorias-lista-categorias");
const convareCategoriasListaGrupos = el("convare-categorias-lista-grupos");
const convareCategoriasLegenda = el("convare-categorias-legenda");
let convareCategoriasResultado = null;

function convareValoresDistintosGrupo() {
  const vistos = new Set();
  convareRegistros.forEach((r) => {
    const valor = (r.dados.grupo || "").trim();
    if (valor) vistos.add(valor);
  });
  return Array.from(vistos).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
}

// "Categoria" pode ter vários códigos separados por vírgula numa única
// célula (ex.: "COD1,COD2") — cada código conta como um valor distinto,
// mesmo critério de conversor_areas.listar_categorias_e_grupos no backend.
function convareValoresDistintosCategoria() {
  const vistos = new Set();
  convareRegistros.forEach((r) => {
    (r.dados.categoria || "").split(",").forEach((c) => {
      const valor = c.trim();
      if (valor) vistos.add(valor);
    });
  });
  return Array.from(vistos).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
}

function renderConvareCategoriasLista(container, itens) {
  container.innerHTML = "";
  itens.forEach(({ valor, cadastrado }) => {
    const li = document.createElement("li");
    if (cadastrado === false) {
      li.classList.add("convvei-templates-faltando");
      li.textContent = `⚠ ${valor}`;
      li.title = "Falta cadastrar na SSX";
    } else if (cadastrado === true) {
      li.textContent = `✓ ${valor}`;
      li.title = "Já cadastrado na SSX";
    } else {
      li.textContent = valor;
    }
    container.appendChild(li);
  });
}

function renderConvareCategoriasModal() {
  if (convareCategoriasResultado) {
    renderConvareCategoriasLista(convareCategoriasListaCategorias, convareCategoriasResultado.categorias);
    renderConvareCategoriasLista(convareCategoriasListaGrupos, convareCategoriasResultado.grupos);
    convareCategoriasLegenda.textContent = "⚠ em vermelho = falta cadastrar na SSX; ✓ = já cadastrado.";
  } else {
    const categorias = convareValoresDistintosCategoria().map((valor) => ({ valor }));
    const grupos = convareValoresDistintosGrupo().map((valor) => ({ valor }));
    renderConvareCategoriasLista(convareCategoriasListaCategorias, categorias);
    renderConvareCategoriasLista(convareCategoriasListaGrupos, grupos);
    convareCategoriasLegenda.textContent = 'Valores usados na planilha — clique em "Verificar cadastro na SSX" pra ver o que já está cadastrado.';
  }
}

async function verificarConvareCategoriasNaSsx() {
  if (!convareFileId) return;
  const btn = el("btn-convare-categorias-verificar-ssx");
  btn.disabled = true;
  btn.textContent = "Verificando...";
  try {
    const r = await fetch("/api/conversor-areas/listar-categorias-grupos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: convareFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      if (r.status === 401 || r.status === 409) {
        convareSsxOk = false;
        convareAtualizarPillAuth();
        convareLoginAoEntrar = verificarConvareCategoriasNaSsx;
        renderSelectConvareCredenciais();
        overlayConvareLogin.classList.remove("hidden");
        return;
      }
      mostrarErroConvare(data.error || "Falha ao consultar categorias/grupos na SSX.");
      return;
    }
    convareCategoriasResultado = { categorias: data.categorias, grupos: data.grupos };
    renderConvareCategoriasModal();
  } catch (err) {
    mostrarErroConvare(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Verificar cadastro na SSX";
  }
}

el("btn-convare-categorias").addEventListener("click", () => {
  if (!convareFileId) {
    return mostrarErroConvare("Carregue e mapeie uma planilha no Conversor de Áreas antes.");
  }
  renderConvareCategoriasModal();
  overlayConvareCategorias.classList.remove("hidden");
});

el("btn-convare-categorias-verificar-ssx").addEventListener("click", () => {
  if (!convareSsxOk) {
    convareLoginAoEntrar = verificarConvareCategoriasNaSsx;
    renderSelectConvareCredenciais();
    overlayConvareLogin.classList.remove("hidden");
    return;
  }
  verificarConvareCategoriasNaSsx();
});

el("convare-categorias-fechar").addEventListener("click", () => {
  overlayConvareCategorias.classList.add("hidden");
});

function baixarConvareArquivo(modo) {
  const a = document.createElement("a");
  a.href = `/api/conversor-areas/exportar/${convareFileId}/${modo}`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const overlayConvareBaixarErro = el("overlay-convare-baixar-erro");
const textoConvareBaixarErro = el("convare-baixar-erro-texto");
let resolverConvareBaixarErro = null;
function fecharConvareBaixarErro(escolha) {
  overlayConvareBaixarErro.classList.add("hidden");
  const resolve = resolverConvareBaixarErro;
  resolverConvareBaixarErro = null;
  if (resolve) resolve(escolha);
}
function confirmarConvareBaixarErro(nComErro) {
  const plural = nComErro === 1 ? "área não passou" : "áreas não passaram";
  textoConvareBaixarErro.textContent =
    `${nComErro} ${plural} na validação e podem ser rejeitadas pelo SSX na importação. Baixe só as válidas, ou inclua as com erro pra corrigir depois.`;
  overlayConvareBaixarErro.classList.remove("hidden");
  return new Promise((resolve) => { resolverConvareBaixarErro = resolve; });
}
el("convare-baixar-erro-fechar").addEventListener("click", () => fecharConvareBaixarErro("cancelar"));
el("btn-convare-baixar-erro-cancelar").addEventListener("click", () => fecharConvareBaixarErro("cancelar"));
el("btn-convare-baixar-com-erros").addEventListener("click", () => fecharConvareBaixarErro("com-erros"));
el("btn-convare-baixar-sem-erros").addEventListener("click", () => fecharConvareBaixarErro("sem-erros"));

el("btn-convare-baixar").addEventListener("click", async () => {
  if (!convareFileId) return;
  const resultado = await rodarValidacaoConvare();
  if (!resultado) return;
  if (resultado.n_erro > 0) {
    const escolha = await confirmarConvareBaixarErro(resultado.n_erro);
    if (escolha === "cancelar") return;
    baixarConvareArquivo(escolha === "com-erros" ? "todos" : "validos");
  } else {
    baixarConvareArquivo("todos");
  }
});

el("btn-convare-importar-api").addEventListener("click", () => {
  if (!convareFileId) {
    return mostrarErroConvare("Carregue e mapeie uma planilha no Conversor de Áreas antes.");
  }
  if (!convareSsxOk) {
    convareLoginAoEntrar = abrirModalImportDeConvare;
    renderSelectConvareCredenciais();
    overlayConvareLogin.classList.remove("hidden");
    return;
  }
  abrirModalImportDeConvare();
});

// --- QUEBRA STRING (rastreadores) ---
// Sub-tela "/ferramentas/quebra-string": entrada + bytes à esquerda, tabela à direita.
const quebraStringInput = el("quebra-string-input");
const quebraStringBytesView = el("quebra-string-bytes");
const btnQuebraString = el("btn-quebra-string");
const quebraStringResultado = el("quebra-string-resultado");

// Conjunto padronizado de informações exibidas para qualquer rastreador.
// chave = o que cada parser de protocolo (parseGT06Pacote22 etc.) deve preencher.
const QUEBRA_STRING_CAMPOS = [
  { chave: "possivelRastreador", label: "Possível rastreador" },
  { chave: "tipoPacote", label: "Tipo de pacote" },
  { chave: "numeroSerial", label: "Número serial" },
  { chave: "idImei", label: "IMEI/ID do Equipamento" },
  { chave: "apelido", label: "Apelido" },
  { chave: "contador", label: "Contador de mensagens" },
  { chave: "firmware", label: "Firmware / Versão" },
  { chave: "iccid", label: "ICCID do chip" },
  { chave: "telefone", label: "Telefone (consulta)" },
  { chave: "comando", label: "Comando / resposta" },
  { chave: "data", label: "Data" },
  { chave: "hora", label: "Hora" },
  { chave: "envio", label: "Data/hora de envio" },
  { chave: "motivoEnvio", label: "Motivo do envio" },
  { chave: "backup", label: "Dado de backup" },
  { chave: "gpsFixo", label: "Posição GPS" },
  { chave: "satelites", label: "Satélites" },
  { chave: "hdop", label: "HDOP" },
  { chave: "latitude", label: "Latitude" },
  { chave: "longitude", label: "Longitude" },
  { chave: "altitude", label: "Altitude" },
  { chave: "velocidade", label: "Velocidade" },
  { chave: "curso", label: "Curso" },
  { chave: "lbs", label: "Torre de celular (LBS)" },
  { chave: "ignicao", label: "Ignição" },
  { chave: "modo", label: "Modo do veículo" },
  { chave: "corteOleo", label: "Óleo/eletricidade" },
  { chave: "alarme", label: "Alarme" },
  { chave: "evento", label: "Evento" },
  { chave: "statusExtra", label: "Outros status" },
  { chave: "tensao", label: "Bateria Principal (Veículo)" },
  { chave: "bateria", label: "Bateria Interna (Backup)" },
  { chave: "sinalGsm", label: "Sinal GSM" },
  { chave: "operadora", label: "Operadora" },
  { chave: "tecnologia", label: "Tecnologia celular" },
  { chave: "temperatura", label: "Temperatura" },
  { chave: "odometro", label: "Odômetro" },
  { chave: "horimetro", label: "Horímetro" },
  { chave: "tipoUpload", label: "Tipo de upload" },
  { chave: "motorista", label: "Motorista" },
  { chave: "entrada1", label: "Entrada Digital 1 (Input 1)" },
  { chave: "entrada2", label: "Entrada Digital 2 (Input 2)" },
  { chave: "saida1", label: "Saída 1 (Output 1)" },
  { chave: "saida2", label: "Saída 2 (Output 2)" },
  { chave: "entradas", label: "Entradas Digitais (Inputs)" },
  { chave: "saidas", label: "Saídas (Outputs)" },
  { chave: "assigns", label: "Campos configuráveis (ASSIGN)" },
  { chave: "entradaAnalogica", label: "Entrada analógica (4–20 mA)" },
  { chave: "mensagemTransparente", label: "Mensagem transparente (RS232)" },
  { chave: "canOdometro", label: "CAN odômetro" },
  { chave: "canHorimetro", label: "CAN horímetro" },
  { chave: "canVelocidade", label: "CAN velocidade" },
  { chave: "canRpm", label: "CAN RPM" },
  { chave: "canOnOff", label: "CAN liga/desliga" },
  { chave: "canPedal", label: "CAN pedal do acelerador" },
  { chave: "canCombustivel", label: "CAN nível de combustível" },
  { chave: "canAutonomia", label: "CAN autonomia" },
  { chave: "canConsumo", label: "CAN consumo" },
  { chave: "canCombustivelUsado", label: "CAN combustível utilizado" },
  { chave: "canTempOleo", label: "CAN temperatura do óleo" },
];

// Campos que cada equipamento consegue enviar (em qualquer tipo de pacote). A tabela mostra só
// esses, na ordem de QUEBRA_STRING_CAMPOS; o que o pacote atual não trouxe aparece como "-".
// Protocolo novo: criar o perfil aqui e devolver `perfil` no parser.
const QUEBRA_STRING_PERFIS = {
  GT06: [
    "possivelRastreador", "tipoPacote", "idImei", "telefone", "comando",
    "data", "hora", "gpsFixo", "satelites", "latitude", "longitude", "velocidade", "curso", "lbs",
    "ignicao", "corteOleo", "alarme", "statusExtra", "bateria", "sinalGsm", "odometro", "tipoUpload",
  ],
  E3: [
    "possivelRastreador", "tipoPacote", "idImei", "telefone", "comando",
    "data", "hora", "gpsFixo", "satelites", "latitude", "longitude", "altitude", "velocidade", "curso", "lbs",
    "ignicao", "corteOleo", "alarme", "statusExtra", "bateria", "tensao", "sinalGsm", "temperatura", "odometro",
    "motorista", "entrada1", "entrada2", "saida1", "saida2",
  ],
  JR12: [
    "possivelRastreador", "tipoPacote", "numeroSerial", "idImei", "apelido", "contador",
    "data", "hora", "envio", "backup", "gpsFixo", "satelites", "hdop", "latitude", "longitude", "altitude",
    "velocidade", "curso", "ignicao", "corteOleo", "evento", "bateria", "tensao", "sinalGsm", "operadora",
    "tecnologia", "odometro", "horimetro", "motorista", "entrada1", "entrada2", "saida1", "saida2",
    "entradaAnalogica", "mensagemTransparente",
    "canOdometro", "canHorimetro", "canVelocidade", "canRpm", "canOnOff", "canPedal", "canCombustivel",
    "canAutonomia", "canConsumo", "canCombustivelUsado", "canTempOleo",
  ],
  SUNTECH: [
    "possivelRastreador", "tipoPacote", "idImei", "firmware", "contador", "iccid", "telefone",
    "data", "hora", "backup", "motivoEnvio", "gpsFixo", "satelites", "latitude", "longitude",
    "velocidade", "curso", "lbs", "ignicao", "modo", "alarme", "statusExtra", "sinalGsm",
    "entradas", "saidas", "mensagemTransparente", "assigns",
  ],
  MT2000: [
    "possivelRastreador", "tipoPacote", "numeroSerial", "idImei", "iccid", "telefone", "firmware", "contador",
    "comando", "data", "hora", "backup", "motivoEnvio", "gpsFixo", "satelites", "hdop", "latitude", "longitude",
    "velocidade", "curso", "lbs", "ignicao", "alarme", "statusExtra", "tensao", "bateria", "sinalGsm",
    "odometro", "horimetro", "entrada1", "saida1",
  ],
  // Os valores de I/O (ignição, entradas, CAN, etc.) não entram aqui: cada um vira a sua
  // própria linha dinâmica na tabela (ver "linhasExtras" em parseTeltonikaAvl), porque o
  // conjunto de IOs enviado muda de equipamento pra equipamento e de configuração pra configuração.
  TELTONIKA: [
    "possivelRastreador", "tipoPacote", "idImei", "contador", "motivoEnvio",
    "data", "hora", "gpsFixo", "satelites", "latitude", "longitude", "altitude", "velocidade", "curso",
  ],
};

function hexParaBytes(hexLimpo) {
  const bytes = [];
  for (let i = 0; i < hexLimpo.length; i += 2) {
    bytes.push(hexLimpo.slice(i, i + 2));
  }
  return bytes;
}

function hexParaInt(hex) {
  return parseInt(hex, 16);
}

function formatarDataBR(d) {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

function formatarHoraBR(d) {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mi}:${ss}`;
}

// Protocolo GT06 (Concox e compatíveis), conforme o GPS Tracker Communication Protocol v1.8.1.
// Estrutura geral: 78 78 | tamanho (1) | protocolo (1) | conteúdo | serial (2) | CRC-ITU (2) | 0D 0A
// tamanho = bytes entre o campo tamanho e o CRC, inclusive (total do pacote = tamanho + 5).
const GT06_TIPO_PACOTE = {
  "01": "Login",
  "12": "Localização (GPS + LBS)",
  "13": "Status (heartbeat)",
  "15": "Resposta a comando",
  "16": "Alarme (GPS + LBS + status)",
  "17": "Endereço em chinês (resposta do servidor)",
  "1A": "Consulta de endereço por telefone",
  "22": "Posição (layout de exemplo)",
  "80": "Comando do servidor",
};

// GPS data upload mode (não vale para a série 06).
const GT06_TIPO_UPLOAD = {
  "00": "Envio por intervalo de tempo",
  "01": "Envio por intervalo de distância",
  "02": "Envio por ponto de inflexão",
  "03": "Envio por status do ACC",
  "04": "Reenvio do último ponto GPS ao voltar a ficar parado",
  "05": "Envio do último ponto válido ao recuperar a rede",
};

// Alarme (primeiro byte de alarme/idioma), tabela 5.3.1.17 do protocolo.
const GT06_ALARME = ["Normal", "SOS", "Corte de energia", "Vibração/choque", "Entrada em cerca", "Saída de cerca"];
// Nível de tensão, tabela 5.3.1.15.
const GT06_NIVEL_BATERIA = [
  "Sem energia (desligado)",
  "Extremamente baixa",
  "Muito baixa (alarme)",
  "Baixa (uso normal)",
  "Média",
  "Alta",
  "Muito alta",
];
// Sinal GSM, tabela 5.3.1.16.
const GT06_SINAL_GSM = ["Sem sinal", "Extremamente fraco", "Muito fraco", "Bom", "Forte"];

// Formato brasileiro: vírgula decimal, sinal negativo quando aplicável (sul/oeste).
function formatarCoordenada(valor) {
  return valor.toFixed(6).replace(".", ",");
}

function hexParaTexto(hex) {
  return (hex.match(/../g) || []).map((h) => String.fromCharCode(parseInt(h, 16))).join("");
}

// CRC-ITU (CRC-16/X-25), mesmo cálculo do Apêndice A do protocolo, em forma bit a bit.
function crc16Itu(bytesHex) {
  let crc = 0xffff;
  for (const h of bytesHex) {
    crc ^= parseInt(h, 16);
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0x8408 : crc >> 1;
  }
  return ~crc & 0xffff;
}

// Registra um campo: bytes [inicio, inicio+qtd) em hex + valor convertido.
// Se o pacote não tem esses bytes, o campo fica de fora (aparece como "-").
function gt06Campo(campos, bytes, chave, inicio, qtd, calcularFinal) {
  if (!(qtd > 0) || bytes.length < inicio + qtd) return;
  const bruto = bytes.slice(inicio, inicio + qtd).join("");
  campos[chave] = { bruto, final: calcularFinal(bruto), inicioByte: inicio, fimByte: inicio + qtd };
}

// Bloco GPS comum a 0x12, 0x16, 0x1A e ao layout 0x22:
// data/hora (4-9), latitude (11-14), longitude (15-18), velocidade (19), curso/status (20-21).
function gt06PreencherGps(campos, bytes) {
  if (bytes.length >= 10) {
    // Bytes 4-9: Ano, Mês, Dia, Hora, Min, Seg — valor hex direto (não BCD), em UTC.
    const [ano, mes, dia, hora, min, seg] = bytes.slice(4, 10).map(hexParaInt);
    const dataUtc = new Date(Date.UTC(2000 + ano, mes - 1, dia, hora, min, seg));
    // Exibição em horário de Brasília (UTC-3).
    const dataBrasilia = new Date(dataUtc.getTime() - 3 * 60 * 60 * 1000);
    gt06Campo(campos, bytes, "data", 4, 3, () => formatarDataBR(dataBrasilia));
    gt06Campo(campos, bytes, "hora", 7, 3, () => formatarHoraBR(dataBrasilia));
  }

  // Byte 10: nibble alto = tamanho da info GPS, nibble baixo = satélites usados no posicionamento.
  gt06Campo(campos, bytes, "satelites", 10, 1, (b) => String(hexParaInt(b) & 0x0f));
  gt06Campo(campos, bytes, "velocidade", 19, 1, (bruto) => `${hexParaInt(bruto)} km/h`);

  // Sem os bytes 20-21 não dá para saber o hemisfério: as coordenadas ficam de fora.
  if (bytes.length < 22) return;

  // Bytes 20-21: bit13 = GPS diferencial (0 = tempo real), bit12 = GPS posicionado,
  // bit11 = hemisfério da longitude (1=Oeste), bit10 = hemisfério da latitude (1=Norte), bits 0-9 = curso.
  const cursoStatus = hexParaInt(bytes[20] + bytes[21]);
  const sinalLat = cursoStatus & 0x0400 ? 1 : -1;
  const sinalLon = cursoStatus & 0x0800 ? -1 : 1;

  // Coordenadas: valor = minutos × 30000, então graus = valor / 1800000.
  gt06Campo(campos, bytes, "latitude", 11, 4, (bruto) => formatarCoordenada(sinalLat * (hexParaInt(bruto) / 1800000)));
  gt06Campo(campos, bytes, "longitude", 15, 4, (bruto) => formatarCoordenada(sinalLon * (hexParaInt(bruto) / 1800000)));
  gt06Campo(campos, bytes, "curso", 20, 2, () => `${cursoStatus & 0x03ff}°`);
  gt06Campo(campos, bytes, "gpsFixo", 20, 2, () =>
    `${cursoStatus & 0x1000 ? "Posicionado" : "Não posicionado"} (${cursoStatus & 0x2000 ? "diferencial" : "tempo real"})`
  );
}

// LBS: MCC (2), MNC (1), LAC (2), Cell ID (3), a partir de "base" (22 no 0x12/0x22, 23 no 0x16).
function gt06PreencherLbs(campos, bytes, base) {
  gt06Campo(campos, bytes, "lbs", base, 8, () => {
    const mcc = hexParaInt(bytes[base] + bytes[base + 1]);
    const mnc = hexParaInt(bytes[base + 2]);
    const lac = hexParaInt(bytes[base + 3] + bytes[base + 4]);
    const cell = hexParaInt(bytes.slice(base + 5, base + 8).join(""));
    return `MCC ${mcc}, MNC ${mnc}, LAC ${lac}, Cell ID ${cell}`;
  });
}

// Bloco de status: terminal (1 byte), tensão (1), sinal GSM (1), alarme/idioma (2).
// Começa no byte 4 no status 0x13 e no byte 31 no alarme 0x16.
function gt06PreencherStatus(campos, bytes, base) {
  // Bit7 do byte de terminal: 1 = óleo e eletricidade cortados. Bit1: 1 = ACC alto (ignição ligada).
  gt06Campo(campos, bytes, "corteOleo", base, 1, (b) => (hexParaInt(b) & 0x80 ? "Cortado" : "Conectado"));
  gt06Campo(campos, bytes, "ignicao", base, 1, (b) => (hexParaInt(b) & 0x02 ? "Ligada" : "Desligada"));
  // Bit0: antifurto ativado, bit2: carregando, bit6: rastreamento GPS ligado.
  gt06Campo(campos, bytes, "statusExtra", base, 1, (b) => {
    const v = hexParaInt(b);
    return [
      v & 0x01 ? "Antifurto ativado" : "Antifurto desativado",
      v & 0x04 ? "Carregando" : "Sem carga",
      v & 0x40 ? "Rastreamento GPS ligado" : "Rastreamento GPS desligado",
    ].join("; ");
  });
  gt06Campo(campos, bytes, "bateria", base + 1, 1, (b) => GT06_NIVEL_BATERIA[hexParaInt(b)] || `Desconhecido (0x${b})`);
  gt06Campo(campos, bytes, "sinalGsm", base + 2, 1, (b) => GT06_SINAL_GSM[hexParaInt(b)] || `Desconhecido (0x${b})`);
  // Primeiro byte do alarme/idioma (o segundo é o idioma, que não exibimos).
  gt06Campo(campos, bytes, "alarme", base + 3, 1, (b) => GT06_ALARME[hexParaInt(b)] || `Desconhecido (0x${b})`);
}

// Login (0x01): IMEI em BCD, 8 bytes a partir do byte 4.
function gt06PreencherLogin(campos, bytes) {
  // Os 16 dígitos vêm com um 0 à esquerda quando o IMEI tem 15 dígitos.
  gt06Campo(campos, bytes, "idImei", 4, 8, (bruto) => bruto.replace(/^0/, ""));
}

// Comando de texto (0x15 e 0x80): byte 4 = tamanho (4 bytes de Server Flag + conteúdo ASCII).
function gt06PreencherComando(campos, bytes) {
  const tamanhoComando = hexParaInt(bytes[4]);
  gt06Campo(campos, bytes, "comando", 9, tamanhoComando - 4, (bruto) => hexParaTexto(bruto));
}

// Layout de exemplo do protocolo 0x22, mapeado a partir de um pacote real informado pelo usuário.
// O GPS é o mesmo dos demais pacotes; os campos após o byte 29 seguem esse exemplo.
function gt06PreencherLayout22(campos, bytes) {
  gt06Campo(campos, bytes, "ignicao", 30, 1, (bruto) => (hexParaInt(bruto) === 0 ? "Desligada" : "Ligada"));
  gt06Campo(campos, bytes, "tipoUpload", 31, 1, (bruto) => GT06_TIPO_UPLOAD[bruto] || `Desconhecido (0x${bruto})`);
  gt06Campo(campos, bytes, "odometro", 33, 4, (bruto) => `${(hexParaInt(bruto) / 100).toFixed(2)} km`);
}

// Identifica o pacote pelo Protocol Number (byte 3) e extrai os campos que ele traz.
function parseGT06(bytes) {
  const campos = {
    possivelRastreador: { bruto: bytes.slice(0, 2).join(""), final: "GT06 (Concox e compatíveis)", inicioByte: 0, fimByte: 2 },
  };
  if (bytes.length > 3) {
    campos.tipoPacote = {
      bruto: bytes[3],
      final: GT06_TIPO_PACOTE[bytes[3]] || `Desconhecido (0x${bytes[3]})`,
      inicioByte: 3,
      fimByte: 4,
    };
  }

  switch (bytes[3]) {
    case "01":
      gt06PreencherLogin(campos, bytes);
      break;
    case "12":
      gt06PreencherGps(campos, bytes);
      gt06PreencherLbs(campos, bytes, 22);
      break;
    case "13":
      gt06PreencherStatus(campos, bytes, 4);
      break;
    case "15":
    case "80":
      gt06PreencherComando(campos, bytes);
      break;
    case "16":
      gt06PreencherGps(campos, bytes);
      // Byte 22 = tamanho do bloco LBS; o LBS começa no 23.
      gt06PreencherLbs(campos, bytes, 23);
      gt06PreencherStatus(campos, bytes, 31);
      break;
    case "1A":
      gt06PreencherGps(campos, bytes);
      // Bytes 22-42: telefone ASCII com preenchimento de 0x00 à direita.
      gt06Campo(campos, bytes, "telefone", 22, 21, (bruto) => hexParaTexto(bruto).replace(/\0[\s\S]*$/, ""));
      break;
    case "22":
      gt06PreencherGps(campos, bytes);
      gt06PreencherLbs(campos, bytes, 22);
      gt06PreencherLayout22(campos, bytes);
      break;
  }

  return campos;
}

// Confere tamanho, stop bit e CRC-ITU. Não bloqueia a leitura: só devolve o aviso.
function gt06Validar(bytes) {
  if (bytes.length < 3) return "Pacote incompleto.";
  const tamanho = hexParaInt(bytes[2]);
  const problemas = [];
  if (bytes.length !== tamanho + 5) {
    problemas.push(`tamanho declarado ${tamanho + 5} bytes, recebidos ${bytes.length}`);
  }
  if (bytes.slice(-2).join("") !== "0D0A") problemas.push("stop bit 0D 0A ausente");
  if (bytes.length >= tamanho + 3) {
    const crcRecebido = hexParaInt(bytes[tamanho + 1] + bytes[tamanho + 2]);
    if (crcRecebido !== crc16Itu(bytes.slice(2, tamanho + 1))) problemas.push("CRC-ITU não confere");
  }
  return problemas.length ? `Aviso: ${problemas.join("; ")}.` : "";
}

// Protocolo E3 (BWS IoT) v3.7.2: texto ASCII *ET,SN,CMD,DADO1,DADO2,...#
// Cada campo separado por vírgula ocupa uma posição em "bytes" (inicioByte/fimByte = índice do campo).
const E3_TIPO_PACOTE = {
  RG: "Registro",
  HB: "Posição (heartbeat)",
  GZ: "Rastreamento em tempo real",
  FD: "Modo alarme / controle de saídas",
  AM: "Alarme",
  FE: "Cerca quadrada",
  UP: "Manter conexão UDP",
  PW: "Consulta de senha de serviço",
  MM: "Consulta de senha do equipamento",
  DW: "Posição (consulta de endereço)",
  OD: "Limite de velocidade",
  TX: "Manter conexão (online)",
  DX: "Envio de SMS pelo servidor",
  IP: "Alteração de IP e porta",
  LC: "Correção de odômetro",
  SP: "Período de sono",
  AC: "Tempo até dormir após desligar a ignição",
  ZD: "Sensibilidade do sensor de movimento",
  HT: "Intervalo de transmissão",
  PM: "Modo de economia de energia",
  ZH: "Número de monitoramento principal",
  FH: "Números de monitoramento secundários",
  SQ: "Fuso horário",
  LG: "Idioma do SMS",
  WL: "Cerca circular",
  MG: "Resposta por SMS ligada/desligada",
  CQ: "Reiniciar equipamento",
  KS: "Comando SMS enviado pelo servidor",
  CX: "Consulta de status",
  JZ: "Localização por torre de celular",
  CC: "Registro de ignição (ACC)",
  MQ: "Envio de dados armazenados sem GSM",
};

// Comandos cuja mensagem pode vir em Uni_Str (UTF-16 em hex), quando têm um único campo de dados.
const E3_COMANDOS_UNICODE = new Set(["RG", "PW", "DW", "DX", "JZ", "CX"]);

// Código de status (4 bytes, hex). Saída 1/2, entrada 2 e ACC têm linhas próprias na tabela.
const E3_STATUS = [
  [0x01000000, "Modo alarme ativado", "status"],
  [0x02000000, "Entrada em cerca da plataforma (quadrada)", "alarme"],
  [0x04000000, "Saída de cerca da plataforma (quadrada)", "alarme"],
  [0x08000000, "Bateria de backup baixa", "alarme"],
  [0x10000000, "Falha no GPS", "alarme"],
  [0x20000000, "Vibração", "alarme"],
  [0x40000000, "Veículo em movimento", "status"],
  [0x80000000, "Excesso de velocidade", "alarme"],
  [0x00010000, "SOS", "alarme"],
  [0x00020000, "Movimento", "alarme"],
  [0x00040000, "Corte de alimentação externa", "alarme"],
  [0x00400000, "Modo de economia de energia", "status"],
  [0x00000100, "Entrada na cerca circular 1", "alarme"],
  [0x00000200, "Saída da cerca circular 1", "alarme"],
  [0x00000400, "Entrada na cerca circular 2", "alarme"],
  [0x00000800, "Saída da cerca circular 2", "alarme"],
  [0x00001000, "Entrada na cerca circular 3", "alarme"],
  [0x00002000, "Saída da cerca circular 3", "alarme"],
  [0x00004000, "Alarme ADC", "alarme"],
  [0x00008000, "Temperatura", "alarme"],
  [0x00000001, "Aceleração brusca", "alarme"],
  [0x00000002, "Frenagem brusca", "alarme"],
  [0x00000004, "Frenagem de emergência", "alarme"],
];

function formatarNumeroBR(valor, casas) {
  return valor.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

// Registra um campo do E3: tokens [inicio, inicio+qtd), unidos por vírgula.
function e3Campo(campos, tokens, chave, inicio, qtd, calcularFinal) {
  if (tokens.length < inicio + qtd || tokens.slice(inicio, inicio + qtd).some((t) => t === "")) return;
  const bruto = tokens.slice(inicio, inicio + qtd).join(",");
  campos[chave] = { bruto, final: calcularFinal(bruto), inicioByte: inicio, fimByte: inicio + qtd };
}

// Latitude/longitude: hex ÷ 600000; primeiro dígito 8 (bit mais alto) = sul/oeste.
function e3Coordenada(hex) {
  const valor = parseInt(hex, 16);
  const negativo = valor >= 0x80000000;
  return formatarCoordenada((negativo ? -1 : 1) * ((valor % 0x80000000) / 600000));
}

// YYMMDD e HHMMSS: cada par de dígitos é um byte em hex (ex.: 050915 = 21/09/2005).
function e3Data(hex) {
  const [aa, mm, dd] = (hex.match(/../g) || []).map(hexParaInt);
  return `${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}/${2000 + aa}`;
}

function e3Hora(hex) {
  return (hex.match(/../g) || []).map((h) => String(hexParaInt(h)).padStart(2, "0")).join(":");
}

// Uni_Str: texto em UTF-16 (4 dígitos hex por caractere).
function e3TextoUnicode(hex) {
  return (hex.match(/.{4}/g) || []).map((h) => String.fromCharCode(parseInt(h, 16))).join("");
}

// Bloco de posição de HB/AM/DW/CC, a partir do campo A/V em "base":
// A/V, YYMMDD, HHMMSS, Lat, Lon, Velocidade, Curso, Status, Sinal, Bateria, Combustível, Odômetro, Altitude.
function e3PreencherPosicao(campos, tokens, base, sufixoHora) {
  e3Campo(campos, tokens, "gpsFixo", base, 1, (b) => (b.toUpperCase() === "A" ? "Válida (A)" : "Inválida (V)"));
  e3Campo(campos, tokens, "data", base + 1, 1, e3Data);
  e3Campo(campos, tokens, "hora", base + 2, 1, (b) => `${e3Hora(b)} ${sufixoHora}`);
  e3Campo(campos, tokens, "latitude", base + 3, 1, e3Coordenada);
  e3Campo(campos, tokens, "longitude", base + 4, 1, e3Coordenada);
  e3Campo(campos, tokens, "velocidade", base + 5, 1, (b) => `${formatarNumeroBR(hexParaInt(b) / 100, 2)} km/h`);
  e3Campo(campos, tokens, "curso", base + 6, 1, (b) => `${formatarNumeroBR(hexParaInt(b) / 100, 2)}°`);
  e3PreencherStatus(campos, tokens, base + 7);
  e3Campo(campos, tokens, "sinalGsm", base + 8, 1, (b) => `${b}/32`);
  e3Campo(campos, tokens, "bateria", base + 9, 1, (b) => `${b}%`);
  e3Campo(campos, tokens, "odometro", base + 11, 1, (b) => `${formatarNumeroBR(hexParaInt(b) / 10, 1)} km`);
  e3Campo(campos, tokens, "altitude", base + 12, 1, (b) => `${b} m`);
}

function e3PreencherStatus(campos, tokens, idx) {
  const bit = (mascara) => (b) => (parseInt(b, 16) & mascara ? "Ligada" : "Desligada");
  e3Campo(campos, tokens, "ignicao", idx, 1, (b) => (parseInt(b, 16) & 0x00800000 ? "Ligada" : "Desligada"));
  e3Campo(campos, tokens, "entrada1", idx, 1, (b) => (parseInt(b, 16) & 0x00800000 ? "Ligada (ACC)" : "Desligada (ACC)"));
  e3Campo(campos, tokens, "entrada2", idx, 1, (b) => (parseInt(b, 16) & 0x00200000 ? "Ligada (antifurto externo)" : "Desligada"));
  e3Campo(campos, tokens, "corteOleo", idx, 1, (b) => (parseInt(b, 16) & 0x00080000 ? "Cortado" : "Conectado"));
  e3Campo(campos, tokens, "saida1", idx, 1, bit(0x00080000));
  e3Campo(campos, tokens, "saida2", idx, 1, bit(0x00100000));
  const ativos = (b, tipo) =>
    E3_STATUS.filter(([mascara, , t]) => t === tipo && parseInt(b, 16) & mascara).map(([, nome]) => nome);
  e3Campo(campos, tokens, "alarme", idx, 1, (b) => ativos(b, "alarme").join("; ") || "Nenhum");
  e3Campo(campos, tokens, "statusExtra", idx, 1, (b) => ativos(b, "status").join("; ") || "Nenhum");
}

// Campos opcionais no fim de HB/AM/DW/CC. Tensão e satélites são sempre os dois últimos;
// no HB, quando sobram 4 campos após o GPSdata, os dois primeiros são RFID e temperatura.
function e3PreencherFinais(campos, tokens, inicio, comRfid) {
  const sobra = tokens.length - inicio;
  if (sobra >= 2) {
    e3Campo(campos, tokens, "tensao", tokens.length - 2, 1, (b) => `${b.replace(".", ",")} V`);
    e3Campo(campos, tokens, "satelites", tokens.length - 1, 1, (b) => b);
  }
  if (comRfid && sobra === 4) {
    e3Campo(campos, tokens, "motorista", inicio, 1, (b) => `RFID ${b}`);
    e3Campo(campos, tokens, "temperatura", inicio + 1, 1, (b) => `${formatarNumeroBR(hexParaInt(b) / 100, 2)} °C`);
  }
}

function parseE3(texto) {
  const corpo = texto.replace(/^\*/, "").replace(/#\s*$/, "");
  const tokens = corpo.split(",").map((t) => t.trim());
  const cmd = (tokens[2] || "").toUpperCase();
  const campos = {
    possivelRastreador: { bruto: tokens[0], final: "E3 (BWS IoT)", inicioByte: 0, fimByte: 1 },
  };
  e3Campo(campos, tokens, "idImei", 1, 1, (b) => b);
  e3Campo(campos, tokens, "tipoPacote", 2, 1, (b) => E3_TIPO_PACOTE[cmd] || `Desconhecido (${b})`);

  const problemas = [];
  if (!/#\s*$/.test(texto)) problemas.push("fim # ausente");
  if (tokens[1] && !/^\d{15}$/.test(tokens[1])) problemas.push("IMEI não tem 15 dígitos");

  const semFuso = "(horário do rastreador, sem conversão)";
  // Quantidade mínima de campos para o bloco de posição: ET, SN, CMD + 13.
  const exigirPosicao = (base) => {
    if (tokens.length < base + 13) problemas.push(`faltam campos: esperado ao menos ${base + 13}, recebidos ${tokens.length}`);
  };

  switch (cmd) {
    case "HB":
      exigirPosicao(3);
      e3PreencherPosicao(campos, tokens, 3, semFuso);
      // Campo 16 = GPSdata (sinal de 5 satélites); os opcionais começam no 17.
      e3PreencherFinais(campos, tokens, 17, true);
      break;
    case "AM":
    case "DW":
      // DW enviado pelo servidor traz só a mensagem de endereço.
      if (tokens.length === 4) {
        e3Campo(campos, tokens, "comando", 3, 1, (b) => (/^([0-9A-F]{4})+$/i.test(b) ? e3TextoUnicode(b) : b));
        break;
      }
      exigirPosicao(3);
      e3PreencherPosicao(campos, tokens, 3, semFuso);
      e3PreencherFinais(campos, tokens, 16, false);
      break;
    case "CC":
      // Campo 3 = fuso horário configurado no rastreador.
      exigirPosicao(4);
      e3PreencherPosicao(campos, tokens, 4, `(fuso do rastreador: ${tokens[3] || "?"})`);
      e3PreencherFinais(campos, tokens, 17, false);
      break;
    case "TX":
      e3Campo(campos, tokens, "gpsFixo", 3, 1, (b) => (b.toUpperCase() === "A" ? "Válida (A)" : "Inválida (V)"));
      e3Campo(campos, tokens, "data", 4, 1, e3Data);
      e3Campo(campos, tokens, "hora", 5, 1, (b) => `${e3Hora(b)} ${semFuso}`);
      break;
    case "JZ":
      if (tokens.length >= 8) {
        e3Campo(campos, tokens, "lbs", 4, 4, () =>
          `MCC ${tokens[6]}, MNC ${tokens[7]}, LAC ${tokens[5]}, Cell ID ${tokens[4]}`
        );
        break;
      }
    // eslint-disable-next-line no-fallthrough
    default:
      if (cmd === "RG" && /^\d+$/.test(tokens[3] || "")) {
        e3Campo(campos, tokens, "telefone", 3, 1, (b) => b);
      } else if (tokens.length > 3) {
        const unicode =
          E3_COMANDOS_UNICODE.has(cmd) && tokens.length === 4 && /^([0-9A-F]{4})+$/i.test(tokens[3]) && /[A-F]/i.test(tokens[3]);
        e3Campo(campos, tokens, "comando", 3, tokens.length - 3, (b) => (unicode ? e3TextoUnicode(b) : b));
      }
  }

  return {
    campos,
    bytes: tokens,
    aviso: problemas.length ? `Aviso: ${problemas.join("; ")}.` : "",
    separador: ",",
    perfil: "E3",
  };
}

// Protocolo J-R12 (Jmak) v1.1.0: três formatos de envio com os mesmos IDs de parâmetro.
//   String: ~MÁSCARA;campo;campo...|MÁSCARA_CAN;campo...$   (valores legíveis, separados por ";")
//   Zip:    5E + máscara (8 bytes) + campos binários de tamanho fixo + [máscara CAN + campos CAN] + 24
//   JSON:   objeto com chaves curtas (imei, ts, gps...), sem máscara.
// Cada decodificador monta { ID: { v, i, f } } com o valor já convertido (v) e a posição na faixa de
// cima (i..f); jr12Preencher transforma isso nas linhas da tabela, igual para os três formatos.

// Máscara: inteiro de 64 bits; o bit (ID - 1) ligado indica que o parâmetro ID foi enviado.
function jr12IdsDaMascara(hex) {
  const mascara = BigInt("0x" + hex);
  const ids = [];
  for (let id = 1; id <= 64; id++) if ((mascara >> BigInt(id - 1)) & 1n) ids.push(id);
  return ids;
}

const JR12_EVENTOS = {
  111: ["Limite de velocidade", { 1: "limite atingido", 0: "normal" }],
  112: ["Limite de RPM", { 2: "limite intermediário", 3: "limite alto", 0: "normal" }],
  113: ["Ignição (entrada digital 1)", { 1: "ativada", 0: "desativada" }],
  114: ["Envio por ângulo (azimute)", { 1: "ocorrência" }],
  115: ["Frenagem brusca", { 1: "ocorrência" }],
  116: ["Aceleração brusca", { 1: "ocorrência" }],
  117: ["Curva acentuada", { 1: "ocorrência" }],
  118: ["Entrada digital 2", { 1: "ativada", 0: "desativada" }],
  119: ["Limite da entrada analógica", { 1: "limite atingido", 0: "normalizado" }],
  120: ["Cerca", { 1: "entrada", 0: "saída" }],
  121: ["Envio por distância", { 1: "ocorrência" }],
  124: ["Modo bateria interna", { 1: "ativação", 0: "desativação" }],
  125: ["Bateria interna baixa", { 1: "ocorrência" }],
  126: ["Identificador RS232", { 1: "motorista", 4: "passageiro", 2: "desligar veículo" }],
  127: ["Detecção de movimento", { 1: "ocorrência" }],
  131: ["Mensagem transparente", { 1: "ocorrência" }],
};

// ON/OFF CAN: bit0 = freio de estacionamento ... bit5 = limpador de para-brisa.
const JR12_CAN_ONOFF = ["Freio de estacionamento", "Freio", "Embreagem", "Ar condicionado", "Cinto de segurança", "Limpador de para-brisa"];

function jr12DescreverEvento(id, st, nome) {
  const [descricao, estados] = JR12_EVENTOS[Number(id)] || [`Evento desconhecido (${id})`, {}];
  const partes = [descricao];
  if (st !== undefined) partes.push(estados[Number(st)] || `status ${st}`);
  if (nome !== undefined && nome !== "") {
    partes.push(Number(id) === 120 ? `cerca ${nome}` : Number(id) === 126 ? `identificador ${nome}` : String(nome));
  }
  return partes.join(" — ");
}

// Timestamp GMT em ms (o Zip pode mandar o de envio em segundos) → data/hora de Brasília.
function jr12DataHora(valor) {
  const n = Number(valor);
  const brasilia = new Date((n < 1e11 ? n * 1000 : n) - 3 * 60 * 60 * 1000);
  return { data: formatarDataBR(brasilia), hora: formatarHoraBR(brasilia) };
}

// Helper campo(chave, [entradas], calcular) dos protocolos com máscara (J-R12, Suntech): cada entrada
// é { v, i, f } (valor já convertido + posição na faixa de cima). A primeira entrada é obrigatória;
// o destaque vai da menor à maior posição entre as presentes. bruto(i, f) devolve o trecho original.
function criarCampoPorEntradas(campos, bruto) {
  return (chave, entradas, calcular) => {
    if (!entradas[0]) return;
    const presentes = entradas.filter(Boolean);
    const i = Math.min(...presentes.map((e) => e.i));
    const f = Math.max(...presentes.map((e) => e.f));
    campos[chave] = { bruto: bruto(i, f), final: calcular(...entradas.map((e) => e && e.v)), inicioByte: i, fimByte: f };
  };
}

function jr12Preencher(c, d, extras, bruto) {
  const campos = {};
  const campo = criarCampoPorEntradas(campos, bruto);
  const num = (v, casas) => formatarNumeroBR(Number(v), casas);
  const bit = (mascara, sim, nao) => (v) => (Number(v) & mascara ? sim : nao);
  // ID 9, bit3: 1 = timestamp real, 0 = último valor salvo na memória.
  const horaMemoria = c[9] && !(Number(c[9].v) & 8) ? " — hora da memória, não sincronizada" : "";

  campo("numeroSerial", [c[1]], String);
  campo("idImei", [c[2]], String);
  campo("apelido", [c[4]], (v) => (!v || v === "NULL" ? "Sem apelido" : v));
  campo("contador", [c[3]], String);
  campo("data", [c[5]], (v) => jr12DataHora(v).data);
  campo("hora", [c[5]], (v) => `${jr12DataHora(v).hora} (Brasília)${horaMemoria}`);
  campo("envio", [c[26]], (v) => `${jr12DataHora(v).data} ${jr12DataHora(v).hora} (Brasília)`);
  campo("backup", [c[16]], (v) => (Number(v) ? "Sim (reenvio da memória)" : "Não (enviado na hora)"));
  campo("gpsFixo", [c[27]], (v) => ({ 0: "Sem fix", 1: "GPS fixado", 2: "GPS diferencial" }[Number(v)] || `Desconhecido (${v})`));
  campo("satelites", [c[11]], String);
  campo("hdop", [c[13]], (v) => num(v, 2));
  campo("latitude", [c[6]], (v) => formatarCoordenada(Number(v)));
  campo("longitude", [c[7]], (v) => formatarCoordenada(Number(v)));
  campo("altitude", [c[8]], (v) => `${num(v, 2)} m`);
  campo("velocidade", [c[10]], (v) => `${num(v, 2)} km/h`);
  campo("curso", [c[14]], (v) => `${num(v, 2)}°`);
  campo("ignicao", [c[15]], (v) => (Number(v) ? "Ligada" : "Desligada"));
  // Estado I/O: bit0 pós-chave, bit1 entrada 2, bit2 saída corta corrente, bit3 saída 2.
  campo("entrada1", [c[28]], bit(1, "Ativa (pós-chave)", "Inativa (pós-chave)"));
  campo("entrada2", [c[28]], bit(2, "Ativa", "Inativa"));
  campo("saida1", [c[28]], bit(4, "Ativa (corta corrente)", "Inativa (corta corrente)"));
  campo("saida2", [c[28]], bit(8, "Ativa", "Inativa"));
  campo("corteOleo", [c[28]], bit(4, "Cortado", "Conectado"));
  campo("evento", [c[19], c[20], c[21]], jr12DescreverEvento);
  campo("bateria", [c[23]], (v) => `${num(v / 1000, 2)} V (bateria interna)`);
  campo("tensao", [c[22]], (v) => `${num(v / 1000, 2)} V (alimentação)`);
  campo("sinalGsm", [c[12]], (v) => (Number(v) === 99 ? "Sem sinal (99)" : `${v}/31`));
  campo("operadora", [c[24]], (v) => v || "Não informada");
  campo("tecnologia", [c[25]], (v) => ({ 0: "Sem conexão", 2: "2G", 4: "4G" }[Number(v)] || `Desconhecida (${v})`));
  campo("odometro", [c[18]], (v) => `${num(v, 2)} km`);
  campo("horimetro", [c[17]], (v) => `${num(v, 2)} h`);
  campo("motorista", [c[29]], (v) => (Number(v) ? `Tag RFID ${v}` : "Nenhuma tag"));
  campo("entradaAnalogica", [extras.anin], (v) => `${num(v, 2)} mA`);
  campo("mensagemTransparente", [c[31], c[30]], (hex) => {
    const texto = hexParaTexto(String(hex));
    return /^[\x20-\x7E]+$/.test(texto) ? `${hex} (texto: "${texto}")` : String(hex);
  });

  campo("canOdometro", [d[1]], (v) => `${num(v, 2)} km`);
  campo("canHorimetro", [d[2]], (v) => `${num(v, 2)} h`);
  campo("canVelocidade", [d[3]], (v) => `${num(v, 2)} km/h`);
  campo("canRpm", [d[4]], (v) => `${num(v, 2)} rpm`);
  campo("canOnOff", [d[5]], (v) => JR12_CAN_ONOFF.filter((_, n) => Number(v) & (1 << n)).join("; ") || "Nenhum acionado");
  campo("canPedal", [d[7]], (v) => `${v}%`);
  campo("canCombustivel", [d[9], d[8]], (nivel, unidade) => `${nivel} ${unidade === "%" ? "%" : unidade || ""}`.trim());
  campo("canAutonomia", [d[11]], (v) => `${num(v, 2)} km`);
  campo("canConsumo", [d[13], d[12]], (v, unidade) =>
    `${num(v, 2)}${unidade === "H" ? " L/h" : unidade === "K" ? " km/L" : ""}`
  );
  campo("canCombustivelUsado", [d[14]], (v) => `${num(v, 2)} L`);
  campo("canTempOleo", [d[15]], (v) => `${v} °C`);
  return campos;
}

function jr12Resultado(formato, marcador, c, d, extras, tokens, separador, problemas) {
  const juntar = separador === undefined ? "" : separador;
  const campos = jr12Preencher(c, d, extras, (i, f) => tokens.slice(i, f).join(juntar));
  campos.possivelRastreador = { bruto: marcador.bruto, final: "J-R12 (Jmak)", inicioByte: marcador.i, fimByte: marcador.f };
  const temCan = Object.keys(d).length > 0;
  campos.tipoPacote = {
    bruto: c[0] ? String(c[0].v) : "",
    final: `Posição — formato ${formato}${temCan ? ", com dados CAN" : ""}`,
    inicioByte: c[0] && c[0].i,
    fimByte: c[0] && c[0].f,
  };
  return {
    campos,
    bytes: tokens,
    aviso: problemas.length ? `Aviso: ${problemas.join("; ")}.` : "",
    separador,
    perfil: "JR12",
  };
}

// --- J-R12 String ---
// Lê "MÁSCARA;v1;v2..." de uma das partes (comum ou CAN) e registra cada valor no ID da máscara.
function jr12LerString(parte, tokens, destino, problemas, rotulo) {
  const valores = parte.split(";").map((t) => t.trim());
  if (valores.length > 1 && valores[valores.length - 1] === "") valores.pop();
  const mascara = valores.shift();
  if (!/^[0-9A-F]+$/i.test(mascara || "")) {
    problemas.push(`${rotulo}: máscara inválida`);
    return;
  }
  const ids = jr12IdsDaMascara(mascara);
  destino[0] = { v: mascara, i: tokens.length, f: tokens.length + 1 };
  tokens.push(mascara);
  if (ids.length !== valores.length) {
    problemas.push(`${rotulo}: a máscara indica ${ids.length} campos, mas vieram ${valores.length}`);
  }
  ids.forEach((id, n) => {
    if (n >= valores.length) return;
    destino[id] = { v: valores[n], i: tokens.length, f: tokens.length + 1 };
    tokens.push(valores[n]);
  });
}

function parseJR12String(texto) {
  const problemas = [];
  if (!/\$\s*$/.test(texto)) problemas.push("fim $ ausente");
  const [parteComum, parteCan] = texto.replace(/^~/, "").replace(/\$\s*$/, "").split("|");
  const tokens = [];
  const c = {};
  const d = {};
  jr12LerString(parteComum, tokens, c, problemas, "Dados comuns");
  if (parteCan !== undefined) jr12LerString(parteCan, tokens, d, problemas, "CAN");
  // Na String latitude, longitude e altitude já vêm com sinal.
  return jr12Resultado("String", { bruto: "~" }, c, d, {}, tokens, ";", problemas);
}

// --- J-R12 Zip ---
// [tamanho em bytes, conversão]: número = dividir por ele; "big" = inteiro de 64 bits exato.
const JR12_ZIP_COMUM = {
  1: [11, "serial"], 2: [8, "big"], 3: [4, "int"], 4: [10, "ascii"], 5: [8, "int"],
  6: [4, 1e5], 7: [4, 1e5], 8: [3, 100], 9: [1, "int"], 10: [3, 100], 11: [1, "int"], 12: [1, "int"],
  13: [2, 100], 14: [3, 100], 15: [1, "int"], 16: [1, "int"], 17: [5, 100], 18: [5, 100],
  19: [1, "int"], 20: [1, "int"], 21: [8, "big"], 22: [2, "int"], 23: [2, "int"], 24: [4, "ascii"],
  25: [1, "int"], 26: [8, "int"], 27: [1, "int"], 28: [1, "int"], 29: [8, "big"], 30: [1, "int"],
  31: [null, "hex"], // tamanho variável: valor do ID 30
};
const JR12_ZIP_CAN = {
  1: [5, 100], 2: [5, 100], 3: [3, 100], 4: [3, 100], 5: [2, "int"], 7: [1, "int"], 8: [1, "ascii"],
  9: [1, "int"], 11: [3, 100], 12: [1, "ascii"], 13: [2, 100], 14: [5, 100], 15: [1, "temp"],
};

function jr12ZipConverter(hex, tipo) {
  if (tipo === "hex") return hex;
  if (tipo === "ascii") return hexParaTexto(hex).replace(/\0/g, "");
  if (tipo === "serial") {
    // 3 bytes + "-" + 3 bytes + "-" + 3 bytes → XXXXXX-XXXXX-XXXXXXX
    const seg = (h, digitos) => String(parseInt(h, 16)).padStart(digitos, "0");
    return `${seg(hex.slice(0, 6), 6)}-${seg(hex.slice(8, 14), 5)}-${seg(hex.slice(16, 22), 7)}`;
  }
  if (tipo === "big") return BigInt("0x" + hex).toString();
  const inteiro = Number(BigInt("0x" + hex));
  if (tipo === "temp") return inteiro - 40;
  return typeof tipo === "number" ? inteiro / tipo : inteiro;
}

// Lê os IDs da máscara a partir de "pos"; devolve a posição seguinte, ou -1 se não deu para continuar.
function jr12LerZip(bytes, pos, ids, tabela, destino, problemas, rotulo) {
  for (const id of ids) {
    const def = tabela[id];
    if (!def) {
      problemas.push(`${rotulo}: ID ${id} não tem tamanho definido no protocolo, leitura interrompida`);
      return -1;
    }
    const tamanho = def[0] === null ? Number(destino[30] ? destino[30].v : 0) : def[0];
    if (pos + tamanho > bytes.length) {
      problemas.push(`${rotulo}: o pacote termina antes do ID ${id}`);
      return -1;
    }
    destino[id] = { v: jr12ZipConverter(bytes.slice(pos, pos + tamanho).join(""), def[1]), i: pos, f: pos + tamanho };
    pos += tamanho;
  }
  return pos;
}

function parseJR12Zip(bytes) {
  const problemas = [];
  const c = {};
  const d = {};
  const fimDados = bytes[bytes.length - 1] === "24" ? bytes.length - 1 : bytes.length;
  if (fimDados === bytes.length) problemas.push("fim 24 ($) ausente");
  const dados = bytes.slice(0, fimDados);

  if (dados.length < 9) {
    problemas.push("pacote menor que a máscara (8 bytes)");
  } else {
    const mascara = dados.slice(1, 9).join("");
    c[0] = { v: mascara, i: 1, f: 9 };
    let pos = jr12LerZip(dados, 9, jr12IdsDaMascara(mascara), JR12_ZIP_COMUM, c, problemas, "Dados comuns");
    // Não há separador: se sobraram 8+ bytes depois dos dados comuns, é a máscara CAN.
    if (pos >= 0 && dados.length - pos >= 8) {
      const mascaraCan = dados.slice(pos, pos + 8).join("");
      d[0] = { v: mascaraCan, i: pos, f: pos + 8 };
      pos = jr12LerZip(dados, pos + 8, jr12IdsDaMascara(mascaraCan), JR12_ZIP_CAN, d, problemas, "CAN");
    }
    if (pos >= 0 && pos < dados.length) problemas.push(`${dados.length - pos} byte(s) sobrando no fim`);
  }

  // No Zip latitude/longitude/altitude vêm sem sinal; ID 9: bit0 lat, bit1 lon, bit2 alt negativas.
  const gnss = c[9] ? Number(c[9].v) : 0;
  [[6, 1], [7, 2], [8, 4]].forEach(([id, mascara]) => {
    if (c[id] && gnss & mascara) c[id].v = -c[id].v;
  });
  return jr12Resultado("Zip", { bruto: "5E", i: 0, f: 1 }, c, d, {}, bytes, "", problemas);
}

// --- J-R12 JSON ---
const JR12_JSON_COMUNS = {
  s_num: 1, imei: 2, cnt: 3, name: 4, ts: 5, alt: 8, speed: 10, nsat: 11, rssi: 12, hdop: 13, azi: 14,
  ive: 15, bckup: 16, hourmt: 17, odomt: 18, vin: 22, bat: 23, ope: 24, tec: 25, ts_n: 26, fix: 27,
  ios: 28, tag: 29, trp: 31,
};
// Chaves CAN do JSON → IDs CAN do String/Zip ("4" e "10" trazem valor + unidade juntos).
const JR12_JSON_CAN = { 1: 3, 2: 4, 3: 1, 5: 15, 6: 7, 7: 5, 9: 11, 11: 2, 14: 14 };

function parseJR12Json(texto) {
  let obj;
  try {
    // Os exemplos do manual trazem comentários "//"; o rastreador não manda, mas aceitamos colados.
    obj = JSON.parse(texto.replace(/\/\/[^\n]*/g, ""));
  } catch (e) {
    return { campos: {}, bytes: [], aviso: `JSON inválido: ${e.message}` };
  }
  const tokens = [];
  const c = {};
  const d = {};
  const extras = {};
  const registrar = (rotulo, valor) => {
    tokens.push(`${rotulo}: ${JSON.stringify(valor)}`);
    const i = tokens.length - 1;
    return (v) => ({ v, i, f: i + 1 });
  };

  Object.entries(obj).forEach(([chave, valor]) => {
    if (chave === "evt" || chave === "can") return;
    const entrada = registrar(chave, valor);
    if (chave === "gps" && Array.isArray(valor)) {
      c[6] = entrada(valor[0]);
      c[7] = entrada(valor[1]);
    } else if (chave === "tup") {
      c[9] = entrada(valor ? 8 : 0); // mesmo bit3 do byte de informações GNSS
    } else if (chave === "anin") {
      extras.anin = entrada(valor);
    } else if (JR12_JSON_COMUNS[chave]) {
      c[JR12_JSON_COMUNS[chave]] = entrada(valor);
    }
  });
  [["id", 19], ["st", 20], ["name", 21]].forEach(([chave, id]) => {
    if (obj.evt && obj.evt[chave] !== undefined) c[id] = registrar(`evt.${chave}`, obj.evt[chave])(obj.evt[chave]);
  });
  Object.entries(obj.can || {}).forEach(([chave, valor]) => {
    const entrada = registrar(`can.${chave}`, valor);
    const unidade = String(valor).replace(/[\d.,\s-]/g, "");
    const numero = parseFloat(String(valor).replace(/[^\d.-]/g, ""));
    if (chave === "4") {
      d[9] = entrada(numero);
      d[8] = entrada(unidade);
    } else if (chave === "10") {
      d[13] = entrada(numero);
      d[12] = entrada(unidade);
    } else if (JR12_JSON_CAN[chave]) {
      d[JR12_JSON_CAN[chave]] = entrada(valor);
    }
  });

  return jr12Resultado("JSON", { bruto: "{ }" }, c, d, extras, tokens, " · ", []);
}

// Protocolo Suntech Universal (ST4300/ST4340/ST4500...), Device Communication Guide rev 1.96.
//   Normal: HDR;DEV_ID;REPORT_MAP;campo;campo...   (texto separado por ";")
//   Zip:    HDR (1) + PKT_LEN (2) + DEV_ID (5, BCD) + REPORT_MAP (3) + campos binários de tamanho fixo
// O REPORT_MAP diz quais campos vieram (bit N = campo N); os campos 19-23 mudam por tipo de relatório.
// Os dois formatos viram { CHAVE: { v, i, f } } com o mesmo valor normalizado; stPreencher monta a tabela.

const ST_RELATORIOS = {
  STT: "Status (posição periódica)",
  ALT: "Alerta",
  ALV: "Keep-alive",
  UEX: "Dados de dispositivo serial (RS232)",
  TRV: "Resumo de viagem",
  CAM: "Câmera",
  FTR: "Rastreamento fino",
  CID: "ICCID do chip",
  MNT: "Manutenção",
  RFA: "Evento RF",
  GED: "Dados do motor (GED)",
  PRM: "Parâmetros (IP)",
  ACK: "Confirmação (ACK)",
  CRR: "Reconstrução de colisão",
};
// Byte de cabeçalho do Zip → relatório. 9x / EA = mesmo relatório pedindo ACK do servidor.
const ST_ZIP_HDR = {
  "81": "STT", "91": "STT", "82": "ALT", "92": "ALT", "83": "ALV", "84": "UEX", "94": "UEX",
  "85": "TRV", "95": "TRV", "86": "CAM", "87": "CAM", "97": "CAM", "89": "FTR", "8C": "CID", "9C": "CID",
  "90": "ACK", FA: "RFA", EA: "RFA",
};
const ST_MODELOS = { 36: "ST4300", 46: "ST4500", 47: "ST4340", 49: "ST4340R", 52: "ST4340LC" };

// [bit do REPORT_MAP, campo, bytes no Zip]. "alertData"/"len" = tamanho vem de um campo anterior.
const ST_CAMPOS_BASE = [
  [1, "MODEL", 1], [2, "SW_VER", 3], [3, "MSG_TYPE", 1], [4, "DATE", 3], [5, "TIME", 3], [6, "CELL_ID", 4],
  [7, "MCC", 2], [8, "MNC", 2], [9, "LAC", 2], [10, "RX_LVL", 1], [11, "LAT", 4], [12, "LON", 4],
  [13, "SPD", 2], [14, "CRS", 2], [15, "SATT", 1], [16, "FIX", 1], [17, "IN_STATE", 1], [18, "OUT_STATE", 1],
];
const ST_CAMPOS_POR_TIPO = {
  STT: [[19, "MODE", 1], [20, "STT_RPT_TYPE", 1], [21, "MSG_NUM", 2], [22, "RESERVED", 1], [23, "ASSIGN_MAP", 4]],
  ALT: [[19, "ALERT_ID", 1], [20, "ALERT_MOD", 2], [21, "ALERT_DATA", "alertData"], [22, "RESERVED", 1], [23, "ASSIGN_MAP", 4]],
  UEX: [[19, "LEN", 2], [20, "DATA", "len"], [21, "CHK_SUM", 1], [22, "ST25T_PORT", 1]],
};

const ST_MODOS = ["Estacionado", "Dirigindo", "Ocioso (parado ligado)", "Excesso de velocidade", "Reboque", "Zona de desativação", "Emergência"];
const ST_TIPO_ENVIO = ["Resposta a comando", "Por tempo", "Por distância", "Por ângulo/curva"];
const ST_ALERTAS = {
  1: "Excesso de velocidade", 2: "Velocidade normalizada", 3: "Antena GPS desconectada", 4: "Antena GPS conectada",
  5: "Saída de cerca", 6: "Entrada em cerca", 8: "Antena GPS em curto", 9: "Entrou em modo sleep", 10: "Saiu do modo sleep",
  11: "Entrada em nível alto", 12: "Entrada aterrada (nível baixo)", 13: "Erro na bateria de backup",
  14: "Bateria do veículo baixa", 15: "Impacto (choque)", 16: "Colisão detectada", 17: "Movimento detectado",
  29: "Entrou em modo direção", 31: "Entrou em modo estacionado", 33: "Ignição ligada", 34: "Ignição desligada",
  35: "Ociosidade excessiva", 36: "Entrou em modo excesso de velocidade", 40: "Alimentação principal conectada",
  41: "Alimentação principal desconectada", 42: "Botão de pânico", 43: "Bateria de backup baixa",
  44: "Bateria de backup conectada", 45: "Bateria de backup desconectada", 46: "Aceleração brusca",
  47: "Frenagem brusca", 48: "Curva brusca à esquerda", 49: "Curva brusca à direita", 50: "Jammer detectado",
  55: "Botão liga/desliga pressionado", 56: "Ímã detectado", 57: "Ímã removido", 58: "Reboque detectado",
  59: "Leitura de iButton", 61: "Motor: excesso de rotação", 62: "Motor: violação de velocidade",
  63: "Motor: temperatura do arrefecimento", 64: "Motor: pressão do óleo", 65: "Motor: violação de RPM",
  66: "Motor: código de falha (DTC)", 67: "Chamada de voz", 68: "Entrou em modo ocioso", 69: "RS232 conectado/desconectado",
  70: "ST20U conectado", 71: "ST20U desconectado", 72: "Chip (SIM) removido", 73: "Antifurto",
  74: "Saída de cerca poligonal", 75: "Temperatura alta", 76: "Temperatura baixa", 77: "Temperatura normalizada",
  79: "Entrada em cerca poligonal", 82: "Parâmetros OBD configurados", 85: "ST25T conectado",
  86: "ST25T desconectado / calibração DPA concluída", 87: "Combustível RS232: falha na varredura",
  88: "Combustível RS232: nível máximo excedido", 89: "Sensor de combustível conectado",
  90: "Sensor de combustível desconectado", 91: "Nível de combustível baixo", 92: "Nível de combustível alto",
  93: "Leitura de RFID", 97: "Mudança no fix do GPS", 99: "Equipamento ligado",
  100: "Excesso de velocidade em cerca poligonal", 101: "Velocidade normalizada em cerca poligonal",
  103: "Evento MDSM-7 (fadiga do motorista)", 104: "Evento MDAS-9 (assistência ao motorista)",
  129: "Excesso de velocidade em cerca circular", 130: "Velocidade normalizada em cerca circular",
  131: "Carreta desengatada", 133: "Modo emergência", 141: "Perda de conexão de rede",
  142: "Bank truck ativado (cerca poligonal)", 143: "Bank truck ativado (cerca circular)",
};

// Zip: inteiro de 32 bits com sinal. O manual fala em "bit 31 = negativo" (sinal e magnitude), mas há
// firmware que manda em complemento de 2; as faixas não se sobrepõem, então dá para detectar.
function stCoordenadaZip(hex) {
  const n = parseInt(hex, 16);
  if (n < 0x80000000) return n / 1e6;
  if (n <= 0x8ABA9500) return -(n - 0x80000000) / 1e6;
  return (n - 0x100000000) / 1e6;
}

// Normaliza um campo para o mesmo valor nos dois formatos.
const ST_CONVERTER = {
  zip: {
    MODEL: (h) => hexParaInt(h),
    SW_VER: (h) => (h.match(/../g) || []).map(hexParaInt).join("."),
    // 10 0B 11 → "20161117" (mesmo formato do Normal)
    DATE: (h) => "20" + (h.match(/../g) || []).map((b) => String(hexParaInt(b)).padStart(2, "0")).join(""),
    TIME: (h) => (h.match(/../g) || []).map((b) => String(hexParaInt(b)).padStart(2, "0")).join(":"),
    CELL_ID: (h) => h,
    LAC: (h) => h,
    LAT: stCoordenadaZip,
    LON: stCoordenadaZip,
    SPD: (h) => hexParaInt(h) / 100,
    CRS: (h) => hexParaInt(h) / 100,
    ALERT_MOD: (h) => ({ mod: hexParaInt(h.slice(0, 2)), tamanho: hexParaInt(h.slice(2, 4)) }),
    ALERT_DATA: (h) => h,
    DATA: (h) => h,
    RESERVED: (h) => h,
    _padrao: (h) => hexParaInt(h),
  },
  normal: {
    SW_VER: (t) => t,
    DATE: (t) => t,
    TIME: (t) => t,
    CELL_ID: (t) => t,
    LAC: (t) => t,
    LAT: (t) => parseFloat(t),
    LON: (t) => parseFloat(t),
    SPD: (t) => parseFloat(t),
    CRS: (t) => parseFloat(t),
    IN_STATE: (t) => parseInt(t, 2),
    OUT_STATE: (t) => parseInt(t, 2),
    ALERT_MOD: (t) => ({ mod: t === "" ? undefined : parseInt(t, 10) }),
    ALERT_DATA: (t) => t,
    DATA: (t) => t,
    CHK_SUM: (t) => parseInt(t, 16),
    ASSIGN_MAP: (t) => parseInt(t, 16),
    RESERVED: (t) => t,
    _padrao: (t) => parseInt(t, 10),
  },
};

function stConverter(formato, chave, bruto) {
  const tabela = ST_CONVERTER[formato];
  return (tabela[chave] || tabela._padrao)(bruto);
}

function stBitsAtivos(valor, nomes) {
  return nomes.filter((_, n) => valor & (1 << n));
}

function stDescreverAlerta(id, mod, dados, formato) {
  const partes = [ST_ALERTAS[id] || `Alerta desconhecido (${id})`];
  const m = mod && mod.mod;
  if ([5, 6, 74, 79, 100, 101].includes(id) && m !== undefined) partes.push(`cerca ${m}`);
  if ([11, 12, 42].includes(id) && m !== undefined) partes.push(`entrada ${m}`);
  if ([75, 76, 77].includes(id)) {
    if (m !== undefined) partes.push(`sensor ${m}`);
    if (dados) {
      // Zip: 2 bytes, bit 15 = negativo, valor / 10. Normal: já vem "+22.3".
      let temp = formato === "zip" ? (hexParaInt(dados) & 0x7fff) / 10 : parseFloat(dados);
      if (formato === "zip" && hexParaInt(dados) & 0x8000) temp = -temp;
      partes.push(`${formatarNumeroBR(temp, 1)} °C`);
    }
  } else if (id === 93 && dados) {
    partes.push(`tag ${dados}`);
  } else if (id === 59 && dados) {
    partes.push(`iButton ${dados}${m === 1 ? " (cadastrado)" : m === 0 ? " (não cadastrado)" : ""}`);
  } else if (dados) {
    partes.push(`dados ${dados}`);
  }
  return partes.join(" — ");
}

// Data/hora GPS (UTC) → Brasília.
function stDataHora(data, hora) {
  const [a, m, d] = [data.slice(0, 4), data.slice(4, 6), data.slice(6, 8)].map(Number);
  const [hh, mi, ss] = hora.split(":").map(Number);
  const brasilia = new Date(Date.UTC(a, m - 1, d, hh, mi, ss) - 3 * 60 * 60 * 1000);
  return { data: formatarDataBR(brasilia), hora: formatarHoraBR(brasilia) };
}

function stPreencher(v, tipo, formato, bruto) {
  const campos = {};
  const campo = criarCampoPorEntradas(campos, bruto);
  const num = (x, casas) => formatarNumeroBR(Number(x), casas);

  campo("idImei", [v.DEV_ID], String);
  campo("firmware", [v.SW_VER], String);
  campo("backup", [v.MSG_TYPE], (x) => (Number(x) === 0 ? "Sim (armazenado na memória)" : "Não (tempo real)"));
  if (v.DATE && v.TIME) {
    campo("data", [v.DATE, v.TIME], (d, h) => stDataHora(d, h).data);
    campo("hora", [v.TIME, v.DATE], (h, d) => `${stDataHora(d, h).hora} (Brasília, convertido do UTC do GPS)`);
  } else {
    campo("data", [v.DATE], (d) => `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)} (UTC)`);
    campo("hora", [v.TIME], (h) => `${h} (UTC)`);
  }
  campo("lbs", [v.CELL_ID, v.MCC, v.MNC, v.LAC], (cell, mcc, mnc, lac) =>
    [mcc !== undefined && `MCC ${mcc}`, mnc !== undefined && `MNC ${mnc}`, lac && `LAC ${lac}`, `Cell ID ${cell}`]
      .filter(Boolean)
      .join(", ")
  );
  campo("sinalGsm", [v.RX_LVL], (x) => `${x} (escala 0–63 no 2G, 0–65 no 4G)`);
  campo("latitude", [v.LAT], (x) => formatarCoordenada(x));
  campo("longitude", [v.LON], (x) => formatarCoordenada(x));
  campo("velocidade", [v.SPD], (x) => `${num(x, 2)} km/h`);
  campo("curso", [v.CRS], (x) => `${num(x, 2)}°`);
  campo("satelites", [v.SATT], String);
  campo("gpsFixo", [v.FIX], (x) => (Number(x) ? "GPS fixado" : "GPS não fixado"));
  // IN_STATE: bit0 = ignição, bits 1-7 = entradas In1-In7 (1 = aterrada). OUT_STATE: bits 0-4 = Out1-Out5.
  campo("ignicao", [v.IN_STATE], (x) => (x & 1 ? "Ligada" : "Desligada"));
  campo("entradas", [v.IN_STATE], (x) => {
    const ativas = stBitsAtivos(x >> 1, ["In1", "In2", "In3", "In4", "In5", "In6", "In7"]);
    return ativas.length ? `Aterradas: ${ativas.join(", ")}` : "Todas abertas";
  });
  campo("saidas", [v.OUT_STATE], (x) => {
    const ativas = stBitsAtivos(x, ["Out1", "Out2", "Out3", "Out4", "Out5"]);
    return `${ativas.length ? `Bit 1: ${ativas.join(", ")}` : "Todas em 0"} (ativa/inativa depende da configuração da saída)`;
  });
  campo("modo", [v.MODE], (x) => ST_MODOS[x] || `Desconhecido (${x})`);
  campo("motivoEnvio", [v.STT_RPT_TYPE], (x) => ST_TIPO_ENVIO[x] || `Desconhecido (${x})`);
  campo("contador", [v.MSG_NUM], (x) => String(x).padStart(4, "0"));
  campo("alarme", [v.ALERT_ID, v.ALERT_MOD, v.ALERT_DATA], (id, mod, dados) => stDescreverAlerta(id, mod, dados, formato));
  campo("mensagemTransparente", [v.DATA, v.LEN], (dados) => {
    if (formato !== "zip") return dados;
    const texto = hexParaTexto(dados);
    return /^[\x20-\x7E]+$/.test(texto) ? `${dados} (texto: "${texto}")` : dados;
  });
  campo("iccid", [v.ICCID], String);
  campo("telefone", [v.PHONE], String);
  campo("statusExtra", [v.ANT, v.BAT], (ant, bat) => {
    const ANT = { C: "conectada", NC: "desconectada", SH: "em curto", NA: "não disponível" };
    const BAT = { C: "conectada", NC: "desconectada", ER: "com erro" };
    return [ant !== undefined && `Antena GPS ${ANT[ant] || ant}`, bat !== undefined && `bateria ${BAT[bat] || bat}`]
      .filter(Boolean)
      .join("; ");
  });
  if (v.ASSIGNS && v.ASSIGNS.length) {
    const i = Math.min(...v.ASSIGNS.map((a) => a.i));
    const f = Math.max(...v.ASSIGNS.map((a) => a.f));
    campos.assigns = {
      bruto: bruto(i, f),
      final: `${v.ASSIGNS.map((a) => `${a.nome} = ${a.v}`).join("; ")} (o que cada posição significa depende da configuração do rastreador)`,
      inicioByte: i,
      fimByte: f,
    };
  }
  return campos;
}

// Nome de cada posição do ASSIGN_MAP: bits 0-14 S_ASSIGN (2 bytes), 15-22 M_ASSIGN (4), 23-30 L_ASSIGN (8).
function stAssignSlot(bit) {
  if (bit < 15) return { nome: `S_ASSIGN${bit + 1}`, tamanho: 2 };
  if (bit < 23) return { nome: `M_ASSIGN${bit - 14}`, tamanho: 4 };
  return { nome: `L_ASSIGN${bit - 22}`, tamanho: 8 };
}

function stResultado(tipo, comAck, formato, v, bytes, separador, problemas, marcador) {
  const campos = stPreencher(v, tipo, formato, (i, f) => bytes.slice(i, f).join(separador));
  const modelo = v.MODEL ? Number(v.MODEL.v) : undefined;
  campos.possivelRastreador = {
    bruto: marcador.bruto,
    final: `Suntech${modelo !== undefined ? ` ${ST_MODELOS[modelo] || `(modelo ${modelo})`}` : ""} — protocolo Universal, formato ${formato === "zip" ? "Zip" : "Normal"}`,
    inicioByte: marcador.i,
    fimByte: marcador.f,
  };
  campos.tipoPacote = {
    bruto: marcador.bruto,
    final: `${ST_RELATORIOS[tipo] || `Desconhecido (${tipo})`}${comAck ? " — pede confirmação (ACK) do servidor" : ""}`,
    inicioByte: marcador.i,
    fimByte: marcador.f,
  };
  if (!ST_CAMPOS_POR_TIPO[tipo] && !["ALV", "CID", "MNT"].includes(tipo)) {
    problemas.push(`o relatório ${tipo} ainda não é decodificado campo a campo; só o cabeçalho foi lido`);
  }
  return {
    campos,
    bytes,
    aviso: problemas.length ? `Aviso: ${problemas.join("; ")}.` : "",
    separador,
    perfil: "SUNTECH",
  };
}

// --- Suntech Normal (texto) ---
function parseSuntechNormal(texto) {
  const tokens = texto.replace(/[\r\n]+$/, "").split(";").map((t) => t.trim());
  const cabecalho = tokens[0].toUpperCase();
  const comAck = /^A(STT|ALT|UEX|TRV|CAM|CID|RFA)$/.test(cabecalho);
  const tipo = comAck ? cabecalho.slice(1) : cabecalho === "GED" ? "GED" : cabecalho;
  const problemas = [];
  const v = {};
  const entrada = (pos, valor) => ({ v: valor, i: pos, f: pos + 1 });
  if (tokens[1] !== undefined) v.DEV_ID = entrada(1, tokens[1]);

  if (tipo === "CID") {
    // CID não tem máscara: DEV_ID;MODEL;SW_VER;DATE;TIME;LAT;LON;ICCID
    ["MODEL", "SW_VER", "DATE", "TIME", "LAT", "LON", "ICCID"].forEach((chave, n) => {
      if (tokens[n + 2] !== undefined) v[chave] = entrada(n + 2, chave === "ICCID" ? tokens[n + 2] : stConverter("normal", chave, tokens[n + 2]));
    });
  } else if (tipo === "MNT") {
    ["SW_VER", "DATE", "TIME", "PROF_VER", "PHONE", "ANT", "BAT"].forEach((chave, n) => {
      if (tokens[n + 2] !== undefined) v[chave] = entrada(n + 2, tokens[n + 2]);
    });
  } else if (ST_CAMPOS_POR_TIPO[tipo]) {
    let pos = 2;
    // REPORT_MAP pode ser omitido pela configuração: aí não dá para saber quais campos vieram.
    if (!/^[0-9A-F]{6}$/i.test(tokens[2] || "") || !(parseInt(tokens[2], 16) & 1)) {
      problemas.push("REPORT_MAP não veio na string (opção \"map removido\"); sem ele não dá para saber quais campos foram enviados");
    } else {
      const mapa = parseInt(tokens[2], 16);
      pos = 3;
      const defs = [...ST_CAMPOS_BASE, ...ST_CAMPOS_POR_TIPO[tipo]];
      defs.forEach(([bit, chave]) => {
        if (!(mapa & (1 << bit)) || pos >= tokens.length) return;
        v[chave] = entrada(pos, stConverter("normal", chave, tokens[pos]));
        pos++;
      });
      const bitsEsperados = defs.filter(([bit]) => mapa & (1 << bit)).length;
      if (pos - 3 < bitsEsperados) problemas.push(`faltam campos: o REPORT_MAP indica ${bitsEsperados}, vieram ${pos - 3}`);
      // ASSIGN_MAP (bit 23): cada bit ligado = mais um valor no fim.
      if (v.ASSIGN_MAP) {
        v.ASSIGNS = [];
        for (let bit = 0; bit < 31; bit++) {
          if (!(v.ASSIGN_MAP.v & (1 << bit)) || pos >= tokens.length) continue;
          v.ASSIGNS.push({ nome: stAssignSlot(bit).nome, v: tokens[pos], i: pos, f: pos + 1 });
          pos++;
        }
      }
      if (pos < tokens.length) {
        const sobra = tokens.slice(pos);
        v.ASSIGNS = (v.ASSIGNS || []).concat(sobra.map((t, n) => ({ nome: `extra ${n + 1}`, v: t, i: pos + n, f: pos + n + 1 })));
        if (!v.ASSIGN_MAP) problemas.push("há campos depois do fim do relatório (ASSIGNs com ASSIGN_MAP omitido?)");
      }
    }
  }
  return stResultado(tipo, comAck, "normal", v, tokens, ";", problemas, { bruto: tokens[0], i: 0, f: 1 });
}

// --- Suntech Zip (hex) ---
function parseSuntechZip(bytes) {
  const tipo = ST_ZIP_HDR[bytes[0]];
  const comAck = /^9|^EA$/.test(bytes[0]) && tipo !== "ACK";
  const problemas = [];
  const v = {};
  const ler = (pos, qtd) => bytes.slice(pos, pos + qtd).join("");

  if (bytes.length >= 3) {
    const declarado = hexParaInt(ler(1, 2));
    if (bytes.length - 3 !== declarado) problemas.push(`PKT_LEN declara ${declarado} bytes após o cabeçalho, vieram ${bytes.length - 3}`);
  }
  if (bytes.length >= 8) v.DEV_ID = { v: ler(3, 5), i: 3, f: 8 };

  let pos = 8;
  const pegar = (chave, qtd) => {
    if (pos + qtd > bytes.length) {
      problemas.push(`o pacote termina antes do campo ${chave}`);
      return false;
    }
    v[chave] = { v: stConverter("zip", chave, ler(pos, qtd)), i: pos, f: pos + qtd };
    pos += qtd;
    return true;
  };

  if (tipo === "CID") {
    [["MODEL", 1], ["SW_VER", 3], ["DATE", 3], ["TIME", 3], ["LAT", 4], ["LON", 4]].every(([c, q]) => pegar(c, q));
    if (pos + 10 <= bytes.length) {
      v.ICCID = { v: ler(pos, 10), i: pos, f: pos + 10 };
      pos += 10;
    }
  } else if (ST_CAMPOS_POR_TIPO[tipo] && bytes.length >= 11) {
    const mapa = hexParaInt(ler(8, 3));
    v.REPORT_MAP = { v: ler(8, 3), i: 8, f: 11 };
    pos = 11;
    for (const [bit, chave, tamanho] of [...ST_CAMPOS_BASE, ...ST_CAMPOS_POR_TIPO[tipo]]) {
      if (!(mapa & (1 << bit))) continue;
      let qtd = tamanho;
      if (tamanho === "alertData") qtd = v.ALERT_MOD ? v.ALERT_MOD.v.tamanho : 0;
      if (tamanho === "len") qtd = v.LEN ? v.LEN.v : 0;
      if (qtd === 0) continue;
      if (!pegar(chave, qtd)) break;
    }
    if (v.ASSIGN_MAP) {
      v.ASSIGNS = [];
      for (let bit = 0; bit < 31; bit++) {
        if (!(v.ASSIGN_MAP.v & (1 << bit))) continue;
        const { nome, tamanho } = stAssignSlot(bit);
        if (pos + tamanho > bytes.length) {
          problemas.push(`o pacote termina antes de ${nome}`);
          break;
        }
        v.ASSIGNS.push({ nome, v: ler(pos, tamanho), i: pos, f: pos + tamanho });
        pos += tamanho;
      }
    }
    if (v.DATA && v.CHK_SUM) {
      const soma = (v.DATA.v.match(/../g) || []).reduce((s, h) => s + hexParaInt(h), 0) & 0xff;
      if (soma !== v.CHK_SUM.v) problemas.push(`checksum dos dados não confere (calculado ${soma.toString(16).toUpperCase()})`);
    }
    if (pos < bytes.length) {
      problemas.push(
        `${bytes.length - pos} byte(s) sobrando no fim (REPORT_MAP/ASSIGN_MAP omitidos pela configuração ou campo fora do manual)`
      );
    }
  } else {
    pos = bytes.length;
  }
  return stResultado(tipo || bytes[0], comAck, "zip", v, bytes, "", problemas, { bruto: bytes[0], i: 0, f: 1 });
}

// Protocolo MT2000 (Mobilogix) "T Message" v1.3.8: texto ASCII [TIMESTAMP,TIPO,campo,...,campo]
// Tx = rastreador → servidor, Sx = servidor → rastreador. Os campos de cada tipo vêm em ordem fixa.
// [nome, grupo]: o grupo define a lista de campos (MT_CAMPOS) e em qual linha o tipo aparece.
const MT_TIPOS = {
  T1: ["Login", "login"],
  T14: ["Heartbeat (ignição desligada)", "heartbeat"],
  T3: ["Posição periódica", "relatorio"],
  T4: ["Posição pedida pelo servidor (resposta ao S4)", "relatorio"],
  T17: ["Mudança de direção (curva)", "relatorio"],
  T20: ["Posição por distância percorrida", "relatorio"],
  T21: ["Ignição ligada (início de viagem)", "relatorio"],
  T22: ["Ignição desligada (fim de viagem)", "relatorio"],
  T23: ["Posição com ignição desligada", "relatorio"],
  T31: ["Posição antes de dormir (sleep)", "relatorio"],
  T8: ["Bateria interna baixa", "alerta"],
  T9: ["Vibração com ignição desligada", "alerta"],
  T10: ["Alimentação principal removida", "alerta"],
  T11: ["Bateria do veículo baixa", "alerta"],
  T12: ["Saída da cerca", "alerta"],
  T13: ["Excesso de velocidade", "alerta"],
  T15: ["Reboque (movimento com ignição desligada)", "alerta"],
  T18: ["Entrada de uso geral ativada", "alerta"],
  T19: ["Entrada de uso geral desativada", "alerta"],
  T24: ["Alimentação principal reconectada", "alerta"],
  T25: ["Bateria do veículo normalizada", "alerta"],
  T26: ["Jammer detectado", "alerta"],
  T27: ["Tombamento (90°)", "alerta"],
  T28: ["Capotamento (180°)", "alerta"],
  T29: ["Tensão alta na bateria do veículo", "alerta"],
  T30: ["Tensão da bateria do veículo normalizada", "alerta"],
  T32: ["Bateria interna normalizada", "alerta"],
  T33: ["Tensão alta na bateria interna", "alerta"],
  T34: ["Tensão da bateria interna normalizada", "alerta"],
  T5: ["Resposta de leitura de configuração", "t5"],
  T6: ["Confirmação de configuração / início de FOTA", "t6"],
  T7: ["Confirmação de reinício", "t7"],
  T16: ["Atualização de firmware (FOTA) concluída", "t16"],
  S1: ["Servidor: resposta ao login", "s1"],
  S4: ["Servidor: pedido de posição", "s4"],
  S5: ["Servidor: leitura de configuração", "s5"],
  S6: ["Servidor: gravação de configuração", "s6"],
  S7: ["Servidor: reiniciar rastreador", "sx"],
};
const MT_CAMPOS = {
  login: ["REPT_TYPE", "PRT_VER", "SN", "MSISDN", "ICCID", "PASS", "IMSI", "IMEI"],
  heartbeat: ["REPT_TYPE", "PRT_VER", "SN", "TERM_STATUS", "BAT_VOLT"],
  relatorio: [
    "REPT_TYPE", "PRT_VER", "SN", "TERM_STATUS", "BAT_VOLT", "LOC_STATUS", "LAT", "LON", "SPEED", "DIR",
    "INT_BATT", "ODO_TRIP", "ODO_TOTAL", "HORIMETER", "HDOP", "MCC", "MNC", "LAC", "CELL_ID", "RX_LEVEL", "SERIAL_COUNTER",
  ],
  t5: ["PARAM_VAL", "SN", "SERIAL_COUNTER"],
  t6: ["PARAM_VAL", "ACCEPT", "SN", "SERIAL_COUNTER"],
  t7: ["ACCEPT", "SERIAL_COUNTER"],
  t16: ["REPT_TYPE", "PRT_VER", "SN", "STATUS", "SERIAL_COUNTER"],
  s1: ["STATUS"],
  s4: ["PERIOD", "COUNT"],
  s5: ["PARAM"],
  s6: ["PARAM_VAL"],
  sx: [],
};
MT_CAMPOS.alerta = MT_CAMPOS.relatorio;

function parseMT2000(textoOriginal) {
  // PDFs e e-mails trocam "-" por hífens Unicode; o buffer manda várias mensagens coladas com \r\n.
  const texto = textoOriginal.replace(/[‐-–−]/g, "-").replace(/\\r\\n/g, "\n");
  const problemas = [];
  const mensagens = texto.match(/\[[^\]]*\]?/g) || [];
  if (mensagens.length > 1) {
    problemas.push(`vieram ${mensagens.length} mensagens coladas (descarga do buffer); mostrando só a primeira`);
  }
  const msg = mensagens[0] || texto;
  if (!/\]\s*$/.test(msg)) problemas.push("fim ] ausente");
  const tokens = msg.replace(/^\s*\[/, "").replace(/\]\s*$/, "").split(",").map((t) => t.trim());

  const tipo = (tokens[1] || "").toUpperCase();
  const [nomeTipo, grupo] = MT_TIPOS[tipo] || [
    /^S\d+$/.test(tipo) ? "Servidor: confirmação (ACK) de mensagem do rastreador" : `Desconhecido (${tipo})`,
    /^S\d+$/.test(tipo) ? "sx" : null,
  ];
  if (!grupo) problemas.push(`tipo ${tipo} não está no manual v1.3.8`);

  const v = {};
  const entrada = (pos) => (tokens[pos] !== undefined && tokens[pos] !== "" ? { v: tokens[pos], i: pos, f: pos + 1 } : undefined);
  v.TS = entrada(0);
  (MT_CAMPOS[grupo] || []).forEach((nome, n) => {
    const e = entrada(n + 2);
    if (e) v[nome] = e;
  });
  const qtdPayload = tokens.length - 2;
  if (["relatorio", "alerta"].includes(grupo) && ![10, 12, 21].includes(qtdPayload)) {
    problemas.push(`esperado 10, 12 ou 21 campos depois do tipo (conforme a versão do firmware), vieram ${qtdPayload}`);
  }

  const campos = {};
  const campo = criarCampoPorEntradas(campos, (i, f) => tokens.slice(i, f).join(","));
  const num = (x, casas) => formatarNumeroBR(Number(x), casas);
  const volts = (x) => `${String(x).replace(".", ",")} V`;

  campos.possivelRastreador = { bruto: "[ ]", final: "MT2000 (Mobilogix) — protocolo T Message" };
  campos.tipoPacote = { bruto: tokens[1], final: nomeTipo, inicioByte: 1, fimByte: 2 };

  // Timestamp do GPS "AAAA-MM-DD HH:MM:SS" (alguns firmwares usam ":" entre data e hora), em UTC.
  const ts = v.TS && v.TS.v.match(/(\d{4})-(\d{2})-(\d{2})[ :T](\d{2}):(\d{2}):(\d{2})/);
  if (ts) {
    const [, a, m, d, hh, mi, ss] = ts.map(Number);
    const brasilia = new Date(Date.UTC(a, m - 1, d, hh, mi, ss) - 3 * 60 * 60 * 1000);
    campo("data", [v.TS], () => formatarDataBR(brasilia));
    campo("hora", [v.TS], () => `${formatarHoraBR(brasilia)} (Brasília, convertido do UTC do GPS)`);
  }

  campo("numeroSerial", [v.SN], String);
  campo("idImei", [v.IMEI], String);
  campo("iccid", [v.ICCID], String);
  campo("telefone", [v.MSISDN], String);
  campo("firmware", [v.PRT_VER], (x) => `Protocolo ${x}`);
  campo("contador", [v.SERIAL_COUNTER], String);
  campo("backup", [v.REPT_TYPE], (x) => (x === "0" ? "Sim (reenvio do buffer)" : "Não (tempo real)"));
  // O próprio tipo diz o motivo do envio (relatórios) ou o alarme (alertas).
  if (grupo === "relatorio") campos.motivoEnvio = { ...campos.tipoPacote };
  if (grupo === "alerta") campos.alarme = { ...campos.tipoPacote };

  // LOC_STATUS (3 dígitos): satélites + sinal GSM (0-9) + fix (0 sem fix, 1 atual, 2 última posição válida).
  campo("satelites", [v.LOC_STATUS], (s) => s[0]);
  campo("gpsFixo", [v.LOC_STATUS], (s) =>
    ({ 0: "Sem fix (sem posição)", 1: "GPS fixado (posição atual)", 2: "Sem fix agora — última posição válida" }[s[2]] ||
      `Desconhecido (${s[2]})`)
  );
  campo("sinalGsm", [v.LOC_STATUS, v.RX_LEVEL], (s, rx) => `${s[1]}/9${rx !== undefined ? ` (RX level ${rx})` : ""}`);
  campo("latitude", [v.LAT], (x) => formatarCoordenada(parseFloat(x)));
  campo("longitude", [v.LON], (x) => formatarCoordenada(parseFloat(x)));
  campo("velocidade", [v.SPEED], (x) => `${x} km/h`);
  campo("curso", [v.DIR], (x) => `${x}°`);
  campo("hdop", [v.HDOP], (x) => num(x, 2));
  campo("lbs", [v.CELL_ID, v.MCC, v.MNC, v.LAC], (cell, mcc, mnc, lac) =>
    [mcc && `MCC ${Number(mcc)}`, mnc && `MNC ${Number(mnc)}`, lac && `LAC ${lac}`, `Cell ID ${cell}`].filter(Boolean).join(", ")
  );
  campo("tensao", [v.BAT_VOLT], volts);
  campo("bateria", [v.INT_BATT], volts);
  campo("odometro", [v.ODO_TOTAL, v.ODO_TRIP], (total, trip) =>
    [`${num(Number(total) / 1000, 2)} km total`, trip !== undefined && `${num(Number(trip) / 1000, 2)} km na viagem`]
      .filter(Boolean)
      .join("; ")
  );
  campo("horimetro", [v.HORIMETER], (x) => `${num(Number(x) / 60, 1)} h (${x} min)`);

  // TERM_STATUS: 2 dígitos hex. bit0 1=saída desativada; bit1 alimentação externa; bit2 ignição (física ou
  // virtual); bit3 em movimento; bit4 dentro da cerca; bit5 fio ACC; bit6 0=movimento indevido; bit7 standby.
  const status = (x) => parseInt(x, 16);
  campo("ignicao", [v.TERM_STATUS], (x) => (status(x) & 0x04 ? "Ligada" : "Desligada"));
  campo("entrada1", [v.TERM_STATUS], (x) => (status(x) & 0x20 ? "Ativa (fio ACC/pós-chave)" : "Inativa (fio ACC/pós-chave)"));
  campo("saida1", [v.TERM_STATUS], (x) => (status(x) & 0x01 ? "Desativada" : "Ativada (normalmente usada para bloqueio)"));
  campo("statusExtra", [v.TERM_STATUS], (x) => {
    const s = status(x);
    return [
      s & 0x02 ? "Alimentação externa conectada" : "Alimentação externa desconectada",
      s & 0x08 ? "em movimento" : "parado",
      s & 0x10 ? "dentro da cerca" : "fora da cerca",
      s & 0x40 ? "movimento permitido" : "movimento indevido",
      s & 0x80 ? "modo standby" : "modo operação",
    ].join("; ");
  });

  // Mensagens de configuração / servidor.
  const aceito = (x) => (x === "1" ? "aceito" : x === "0" ? "recusado" : `status ${x}`);
  if (grupo === "t5") campo("comando", [v.PARAM_VAL], (x) => `Configuração lida: ${x}`);
  if (grupo === "t6") campo("comando", [v.PARAM_VAL, v.ACCEPT], (p, a) => `${p} — ${aceito(a)}`);
  if (grupo === "t7") campo("comando", [v.ACCEPT], (a) => `Reinício ${aceito(a)}`);
  if (grupo === "t16") campo("comando", [v.STATUS], (s) => (s === "1" ? "FOTA concluída com sucesso" : "FOTA com erro"));
  if (grupo === "s1") campo("comando", [v.STATUS], (s) => (s === "1" ? "Login aceito" : "Login recusado (o rastreador vai dormir)"));
  if (grupo === "s4") campo("comando", [v.COUNT, v.PERIOD], (c, p) => `Enviar ${c} posição(ões), a cada ${p || 0} s`);
  if (grupo === "s5") campo("comando", [v.PARAM], (x) => `Ler ${x}`);
  if (grupo === "s6") campo("comando", [v.PARAM_VAL], (x) => `Gravar ${x}`);

  return {
    campos,
    bytes: tokens,
    aviso: problemas.length ? `Aviso: ${problemas.join("; ")}.` : "",
    separador: ",",
    perfil: "MT2000",
  };
}

// Protocolo Teltonika (AVL — Codec 8 / Codec 8 Extended), conforme a wiki oficial
// (wiki.teltonika-gps.com/view/Teltonika_Data_Sending_Protocols). Pacote binário:
// Preamble(4)=00000000 | Tamanho dos dados(4) | Codec ID(1) | Nº registros(1) |
// registros AVL | Nº registros de novo(1) | CRC-16(4, só os 2 últimos bytes valem).
// Codec 8 usa 1 byte para ID/contadores de I/O; Codec 8 Extended usa 2 bytes (e tem um
// grupo a mais, NX, para valores de tamanho variável) — é a diferença que a Teltonika
// recomenda migrar para poder usar AVL IDs acima de 255.
const TELTONIKA_CODEC = { "08": "Codec 8", "8E": "Codec 8 Extended", "10": "Codec 16" };

// Nome e conversão dos AVL IDs mais comuns, conforme a Teltonika Data Sending Parameters ID
// de FMC130 (a mesma numeração AVL vale para a família FMB9XX/FMB130/FMM130/FMC130).
// IDs não mapeados aqui aparecem como "IO <id>" com o valor bruto em hex e decimal.
// 3º item do array = true quando o conversor recebe o hex bruto (texto/ID), não o inteiro.
const TELTONIKA_IO_INFO = {
  1: ["Entrada Digital 1", (v) => (v ? "Ativa" : "Inativa")],
  2: ["Entrada Digital 2", (v) => (v ? "Ativa" : "Inativa")],
  3: ["Entrada Digital 3", (v) => (v ? "Ativa" : "Inativa")],
  4: ["Contador de pulsos (Entrada Digital 1)", (v) => String(v)],
  5: ["Contador de pulsos (Entrada Digital 2)", (v) => String(v)],
  6: ["Entrada Analógica 2", (v) => `${(v / 1000).toFixed(3)} V`],
  9: ["Entrada Analógica 1", (v) => `${(v / 1000).toFixed(3)} V`],
  10: ["Status do cartão SD", (v) => (v ? "Presente" : "Ausente/erro")],
  12: ["Combustível usado (GPS)", (v) => `${(v / 1000).toFixed(3)} L`],
  13: ["Taxa de consumo (GPS)", (v) => `${(v / 100).toFixed(2)} L/100km`],
  15: ["Pontuação eco (Eco Score)", (v) => (v / 100).toFixed(2)],
  16: ["Odômetro total", (v) => `${(v / 1000).toFixed(2)} km`],
  21: ["Sinal GSM", (v) => `Nível ${v}`],
  24: ["Velocidade (GPS)", (v) => `${v} km/h`],
  31: ["Carga do motor, % (OBD)", (v) => `${v}%`],
  66: ["Tensão externa", (v) => `${(v / 1000).toFixed(2)} V`],
  67: ["Tensão da bateria interna", (v) => `${(v / 1000).toFixed(2)} V`],
  68: ["Corrente da bateria interna", (v) => `${v} mA`],
  69: ["Status GNSS", (v) => (v ? "Ligado" : "Desligado")],
  72: ["Temperatura Dallas 1", (v) => `${(telInt32Signed(v) / 10).toFixed(1)} °C`],
  73: ["Temperatura Dallas 2", (v) => `${(telInt32Signed(v) / 10).toFixed(1)} °C`],
  74: ["Temperatura Dallas 3", (v) => `${(telInt32Signed(v) / 10).toFixed(1)} °C`],
  75: ["Temperatura Dallas 4", (v) => `${(telInt32Signed(v) / 10).toFixed(1)} °C`],
  78: ["Chave iButton (ID do motorista)", (hex) => hex.toUpperCase(), true],
  80: ["Modo de dado", (v) => String(v)],
  81: ["Velocidade (CAN)", (v) => `${v} km/h`],
  82: ["Pedal do acelerador (CAN)", (v) => `${v}%`],
  83: ["Combustível usado (CAN)", (v) => `${(v / 10).toFixed(1)} L`],
  84: ["Nível de combustível, litros (CAN)", (v) => `${(v / 10).toFixed(1)} L`],
  85: ["RPM do motor (CAN)", (v) => `${v} rpm`],
  87: ["Odômetro total (CAN)", (v) => `${(v / 1000).toFixed(2)} km`],
  89: ["Nível de combustível, % (CAN)", (v) => `${v}%`],
  102: ["Horímetro do motor (CAN)", (v) => `${(v / 60).toFixed(2)} h`],
  105: ["Odômetro total contado (CAN)", (v) => `${(v / 1000).toFixed(2)} km`],
  107: ["Combustível usado contado (CAN)", (v) => `${(v / 10).toFixed(1)} L`],
  113: ["Nível da bateria interna", (v) => `${v}%`],
  114: ["Torque do motor, % (CAN)", (v) => `${v}%`],
  115: ["Temperatura do motor (CAN)", (v) => `${((v << 16 >> 16) / 10).toFixed(1)} °C`],
  179: ["Saída Digital 1", (v) => (v ? "Ativa" : "Inativa")],
  180: ["Saída Digital 2", (v) => (v ? "Ativa" : "Inativa")],
  181: ["PDOP", (v) => (v / 10).toFixed(1)],
  182: ["HDOP", (v) => (v / 10).toFixed(1)],
  199: ["Odômetro parcial (trip)", (v) => `${(v / 1000).toFixed(2)} km`],
  200: ["Modo de repouso (sleep)", (v) => String(v)],
  207: ["Tag RFID (ID lida)", (hex) => hex.toUpperCase(), true],
  236: ["Alarme", (v) => (v ? "Disparado" : "Normal")],
  237: ["Tipo de rede (Network Type)", (v) => String(v)],
  238: ["ID de usuário (User ID)", (hex) => hex.toUpperCase(), true],
  239: ["Ignição", (v) => (v ? "Ligada" : "Desligada")],
  240: ["Movimento", (v) => (v ? "Em movimento" : "Parado")],
  241: ["Operadora GSM ativa", (v) => String(v)],
  246: ["Reboque (Towing)", (v) => (v ? "Detectado" : "Normal")],
  247: ["Detecção de colisão (Crash)", (v) => String(v)],
  248: ["Imobilizador", (v) => ({ 0: "iButton não conectado", 1: "iButton conectado (imobilizador)", 2: "iButton conectado (condução autorizada)" }[v] ?? String(v))],
  249: ["Interferência GNSS (jamming)", (v) => (v ? "Início da interferência" : "Fim da interferência")],
  251: ["Marcha lenta (Idling)", (v) => (v ? "Em marcha lenta" : "Normal")],
  252: ["Desconexão de energia (Unplug)", (v) => (v ? "Desconectado" : "Normal")],
  255: ["Excesso de velocidade", (v) => `${v} km/h`],
  263: ["Status Bluetooth", (v) => String(v)],
  303: ["Movimento instantâneo", (v) => (v ? "Em movimento" : "Parado")],
  317: ["Contador de eventos de colisão", (v) => String(v)],
  325: ["VIN (CAN)", (hex) => hexParaTexto(hex).replace(/\0+$/, ""), true],
  380: ["Saída Digital 3", (v) => (v ? "Ativa" : "Inativa")],
  381: ["Ground Sense", (v) => (v ? "Ativo" : "Inativo")],
  449: ["Contador de tempo com ignição ligada", (v) => `${(v / 3600).toFixed(2)} h`],
};

// Converte um inteiro sem sinal (até 32 bits, como hexParaInt devolve) pro valor com sinal
// equivalente — necessário pros campos AVL de 4 bytes que são "Signed" (ex: temperatura Dallas).
function telInt32Signed(v) {
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

// IDs que ganham o badge colorido de uma chave já existente (ver quebraStringTom/
// quebraStringNivelBateria) quando viram linha dinâmica da tabela.
const TELTONIKA_IO_CHAVE_BADGE = {
  239: "ignicao",
  113: "bateria",
  236: "alarme",
  246: "alarme",
  251: "alarme",
  252: "alarme",
  249: "alarme",
};

function telIoNomeFinal(id, valorHex) {
  const info = TELTONIKA_IO_INFO[id];
  if (!info) {
    const v = hexParaInt(valorHex || "0");
    return { nome: `IO ${id}`, final: `0x${valorHex} (${v})` };
  }
  const [nome, conversor, usaHexBruto] = info;
  return { nome, final: conversor(usaHexBruto ? valorHex : hexParaInt(valorHex || "0")) };
}

// CRC-16/IBM (ARC): poly 0xA001, init 0x0000 — o cálculo usado pelo protocolo Teltonika.
function crc16Ibm(bytesHex) {
  let crc = 0x0000;
  for (const h of bytesHex) {
    crc ^= parseInt(h, 16);
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc & 0xffff;
}

// Lê o bloco de elementos de I/O a partir de "pos". No Codec 8 (não extendido) o Event IO ID,
// os contadores e os IDs de cada item usam 1 byte; no Codec 8 Extended usam 2 bytes e há um
// grupo a mais (NX) para valores de tamanho variável (Length (2) + Value (N)).
function telParseIoBloco(bytes, pos, extendido) {
  const tamId = extendido ? 2 : 1;
  const ler = (p, q) => bytes.slice(p, p + q).join("");
  if (pos + tamId * 2 > bytes.length) return null;
  const eventoId = hexParaInt(ler(pos, tamId));
  pos += tamId * 2; // Event IO ID + Nº total de IDs (a soma dos grupos abaixo já dá esse total).
  const itens = [];
  for (const tamanhoValor of [1, 2, 4, 8]) {
    if (pos + tamId > bytes.length) break;
    const n = hexParaInt(ler(pos, tamId));
    pos += tamId;
    for (let i = 0; i < n && pos + tamId + tamanhoValor <= bytes.length; i++) {
      const id = hexParaInt(ler(pos, tamId));
      const inicioValor = pos + tamId;
      itens.push({ id, valorHex: ler(inicioValor, tamanhoValor), inicio: pos, fim: inicioValor + tamanhoValor });
      pos = inicioValor + tamanhoValor;
    }
  }
  if (extendido && pos + tamId <= bytes.length) {
    const nx = hexParaInt(ler(pos, tamId));
    pos += tamId;
    for (let i = 0; i < nx && pos + tamId + 2 <= bytes.length; i++) {
      const id = hexParaInt(ler(pos, tamId));
      const tamanhoValor = hexParaInt(ler(pos + tamId, 2));
      const inicioValor = pos + tamId + 2;
      if (inicioValor + tamanhoValor > bytes.length) break;
      itens.push({ id, valorHex: ler(inicioValor, tamanhoValor), inicio: pos, fim: inicioValor + tamanhoValor });
      pos = inicioValor + tamanhoValor;
    }
  }
  return { eventoId, itens, fimPos: pos };
}

// Pacote de identificação (handshake), enviado antes dos pacotes AVL: 2 bytes de tamanho +
// IMEI em ASCII (sem preamble). Devolve null quando o hex não bate com esse formato, pra
// quebrarString() seguir tentando os outros protocolos.
function parseTeltonikaImei(bytes) {
  const tamanho = hexParaInt(bytes[0] + bytes[1]);
  if (!(tamanho >= 8 && tamanho <= 17) || bytes.length !== 2 + tamanho) return null;
  const imeiHex = bytes.slice(2, 2 + tamanho).join("");
  const imei = hexParaTexto(imeiHex);
  if (!/^[0-9]+$/.test(imei)) return null;
  return {
    campos: {
      possivelRastreador: { bruto: bytes.slice(0, 2).join(""), final: "Teltonika (protocolo AVL) — identificação", inicioByte: 0, fimByte: 2 },
      tipoPacote: { bruto: bytes.slice(0, 2).join(""), final: "Login (identificação por IMEI)", inicioByte: 0, fimByte: 2 },
      idImei: { bruto: imeiHex, final: imei, inicioByte: 2, fimByte: 2 + tamanho },
    },
    bytes,
    aviso: "",
    perfil: "TELTONIKA",
  };
}

// Pacote AVL (posições). Decodifica campo a campo só o 1º registro do pacote (igual o GT06 faz
// com o layout de exemplo); "ioElementos" lista todos os IOs desse registro.
function parseTeltonikaAvl(bytes) {
  const ler = (p, q) => bytes.slice(p, p + q).join("");
  const campos = {
    possivelRastreador: { bruto: ler(0, 4), final: "Teltonika (protocolo AVL)", inicioByte: 0, fimByte: 4 },
  };
  if (bytes.length < 10) {
    return { campos, bytes, aviso: "Aviso: pacote incompleto — faltam bytes do cabeçalho (tamanho/codec/nº de registros).", perfil: "TELTONIKA" };
  }

  const problemas = [];
  const dataFieldLength = hexParaInt(ler(4, 4));
  const codecIdHex = bytes[8].toUpperCase();
  const extendido = codecIdHex === "8E";
  campos.tipoPacote = {
    bruto: bytes[8],
    final: TELTONIKA_CODEC[codecIdHex] || `Desconhecido (0x${codecIdHex})`,
    inicioByte: 8,
    fimByte: 9,
  };

  const numeroDeDados = hexParaInt(bytes[9]);
  campos.contador = { bruto: bytes[9], final: `${numeroDeDados} registro(s) AVL no pacote`, inicioByte: 9, fimByte: 10 };

  const tamanhoTotalEsperado = 12 + dataFieldLength;
  if (bytes.length !== tamanhoTotalEsperado) {
    problemas.push(`tamanho declarado ${tamanhoTotalEsperado} bytes, recebidos ${bytes.length}`);
  } else {
    const crcCalculado = crc16Ibm(bytes.slice(8, 8 + dataFieldLength));
    const crcRecebido = hexParaInt(ler(8 + dataFieldLength + 2, 2));
    if (crcRecebido !== crcCalculado) problemas.push("CRC-16 não confere");
  }

  if (codecIdHex !== "08" && !extendido) {
    problemas.push(`codec 0x${codecIdHex} ainda não é decodificado campo a campo (só Codec 8 e Codec 8 Extended)`);
    return { campos, bytes, aviso: `Aviso: ${problemas.join("; ")}.`, perfil: "TELTONIKA" };
  }

  const pos0 = 10;
  if (bytes.length >= pos0 + 24) {
    let pos = pos0;
    const epochMs = hexParaInt(ler(pos, 8));
    const dataUtc = new Date(epochMs);
    const dataBrasilia = new Date(dataUtc.getTime() - 3 * 60 * 60 * 1000);
    campos.data = { bruto: ler(pos, 8), final: formatarDataBR(dataBrasilia), inicioByte: pos, fimByte: pos + 8 };
    campos.hora = { bruto: ler(pos, 8), final: formatarHoraBR(dataBrasilia), inicioByte: pos, fimByte: pos + 8 };
    pos += 8;
    pos += 1; // Priority (0 baixa, 1 alta, 2 pânico) — ainda sem campo próprio na tabela padrão.

    const lonHex = ler(pos, 4);
    const latHex = ler(pos + 4, 4);
    const altHex = ler(pos + 8, 2);
    const anguloHex = ler(pos + 10, 2);
    const satHex = ler(pos + 12, 1);
    const velHex = ler(pos + 13, 2);
    const lon = telInt32Signed(hexParaInt(lonHex)) / 10000000;
    const lat = telInt32Signed(hexParaInt(latHex)) / 10000000;
    const satelites = hexParaInt(satHex);

    campos.longitude = { bruto: lonHex, final: formatarCoordenada(lon), inicioByte: pos, fimByte: pos + 4 };
    campos.latitude = { bruto: latHex, final: formatarCoordenada(lat), inicioByte: pos + 4, fimByte: pos + 8 };
    campos.altitude = { bruto: altHex, final: `${hexParaInt(altHex)} m`, inicioByte: pos + 8, fimByte: pos + 10 };
    campos.curso = { bruto: anguloHex, final: `${hexParaInt(anguloHex)}°`, inicioByte: pos + 10, fimByte: pos + 12 };
    campos.satelites = { bruto: satHex, final: String(satelites), inicioByte: pos + 12, fimByte: pos + 13 };
    campos.velocidade = { bruto: velHex, final: `${hexParaInt(velHex)} km/h`, inicioByte: pos + 13, fimByte: pos + 15 };
    campos.gpsFixo = {
      bruto: satHex,
      final: satelites > 0 ? "Posicionado (GPS)" : "Sem fix (0 satélites)",
      inicioByte: pos + 12,
      fimByte: pos + 13,
    };
    pos += 15;

    const bloco = telParseIoBloco(bytes, pos, extendido);
    let linhasExtras = [];
    if (bloco) {
      campos.motivoEnvio = {
        bruto: ler(pos, extendido ? 2 : 1),
        final:
          bloco.eventoId === 0
            ? "Registro periódico (sem IO de evento)"
            : `${telIoNomeFinal(bloco.eventoId, "0").nome} mudou de valor (gerou o registro)`,
        inicioByte: pos,
        fimByte: pos + (extendido ? 2 : 1),
      };

      // Cada equipamento/configuração manda um conjunto diferente de IOs — em vez de um
      // esquema fixo de colunas, cada IO que vier no pacote vira a sua própria linha na tabela
      // (nome a partir de TELTONIKA_IO_INFO; "IO <id>" quando não é um ID conhecido).
      linhasExtras = bloco.itens.map((it) => {
        const { nome, final } = telIoNomeFinal(it.id, it.valorHex);
        return {
          label: nome,
          bruto: it.valorHex,
          final,
          inicioByte: it.inicio,
          fimByte: it.fim,
          chave: TELTONIKA_IO_CHAVE_BADGE[it.id],
        };
      });
    }

    if (numeroDeDados > 1) {
      problemas.push(`pacote tem ${numeroDeDados} registros AVL — só o 1º está decodificado campo a campo aqui`);
    }

    return {
      campos,
      bytes,
      aviso: problemas.length ? `Aviso: ${problemas.join("; ")}.` : "",
      perfil: "TELTONIKA",
      linhasExtras,
    };
  }

  return { campos, bytes, aviso: problemas.length ? `Aviso: ${problemas.join("; ")}.` : "", perfil: "TELTONIKA" };
}

// Devolve { campos, bytes, aviso, separador, perfil }: campos[chave] = { bruto, final, inicioByte, fimByte }
// (campo ausente = não encontrado nessa string → exibe "-").
// aviso = erro de entrada ou problema de tamanho/CRC; "" quando está tudo certo.
// Roteamento: *ET → E3; ~ → J-R12 String; { → J-R12 JSON; [ → MT2000; STT;/ALT;... → Suntech Normal;
// hex 5E... → J-R12 Zip; hex 81/82/83... → Suntech Zip; hex 00000000... → Teltonika AVL;
// hex 00+tamanho+IMEI ASCII → Teltonika (login); hex 78 78 → GT06.
function quebrarString(strBruta) {
  const texto = (strBruta || "").trim().replace(/^(\\r\\n)+/, "").trim();
  if (/^\*?ET\s*,/i.test(texto)) return parseE3(texto);
  if (texto.startsWith("[")) return parseMT2000(texto);
  if (/^A?(STT|ALT|ALV|UEX|TRV|CAM|FTR|CID|MNT|RFA|GED|PRM|ACK|CRR);/i.test(texto)) return parseSuntechNormal(texto);
  if (texto.startsWith("~")) return parseJR12String(texto);
  if (texto.startsWith("{")) return parseJR12Json(texto);

  // Aceita "0x78 0x78", "78:78", "78-78", "78,78" além de hex corrido.
  const hexLimpo = texto.replace(/0x/gi, "").replace(/[\s:,\-]+/g, "").toUpperCase();
  if (!hexLimpo) return { campos: {}, bytes: [], aviso: "" };
  if (hexLimpo.length % 2 !== 0 || !/^[0-9A-F]+$/.test(hexLimpo)) {
    return {
      campos: {},
      bytes: [],
      aviso:
        "Entrada inválida: use hex em número par de dígitos (GT06, J-R12 Zip, Suntech Zip, Teltonika), texto *ET (E3), ~...$ ou JSON (J-R12), STT;... (Suntech), [...] (MT2000).",
    };
  }

  const bytes = hexParaBytes(hexLimpo);
  if (bytes[0] === "5E") return parseJR12Zip(bytes);
  if (ST_ZIP_HDR[bytes[0]]) return parseSuntechZip(bytes);
  if (bytes.slice(0, 4).join("") === "00000000") return parseTeltonikaAvl(bytes);
  if (bytes[0] === "00" && bytes.length >= 4) {
    const possivelImei = parseTeltonikaImei(bytes);
    if (possivelImei) return possivelImei;
  }
  if (bytes[0] !== "78" || bytes[1] !== "78") {
    return {
      campos: {},
      bytes,
      aviso:
        "Equipamento não reconhecido: o hex precisa começar com 78 78 (GT06), 5E (J-R12 Zip), 81/82/83... (Suntech Zip) ou 00 00 00 00 (Teltonika AVL).",
    };
  }

  return { campos: parseGT06(bytes), bytes, aviso: gt06Validar(bytes), perfil: "GT06" };
}

// "separador" é exibido entre as posições (vírgula nos protocolos de texto, nada no hex).
function renderQuebraStringBytes(bytes, separador) {
  quebraStringBytesView.innerHTML = "";
  if (bytes.length) {
    const titulo = document.createElement("div");
    titulo.className = "quebra-string-bytes-titulo";
    titulo.textContent = "Tokens Extraídos";
    quebraStringBytesView.appendChild(titulo);
  }
  bytes.forEach((byte, i) => {
    if (separador && i > 0) quebraStringBytesView.appendChild(document.createTextNode(separador));
    const span = document.createElement("span");
    span.className = "quebra-string-byte";
    span.dataset.byteIndex = String(i);
    span.textContent = byte;
    quebraStringBytesView.appendChild(span);
  });
}

function destacarBytes(inicioByte, fimByte, ligar) {
  if (inicioByte === undefined) return;
  for (let i = inicioByte; i < fimByte; i++) {
    const span = quebraStringBytesView.querySelector(`[data-byte-index="${i}"]`);
    if (span) span.classList.toggle("hl", ligar);
  }
}

// Linhas da tabela por posição da faixa de bytes (preenchido a cada render), pra o clique num
// byte/token achar a linha que o usa.
let quebraStringLinhasPorByte = new Map();

// Clique num byte/token: destaca as linhas que usam essa posição e rola até a primeira.
quebraStringBytesView.addEventListener("click", (e) => {
  const span = e.target.closest("[data-byte-index]");
  if (!span) return;
  const linhas = quebraStringLinhasPorByte.get(Number(span.dataset.byteIndex)) || [];
  quebraStringResultado.querySelectorAll("tr.qs-linha-selecionada").forEach((tr) => tr.classList.remove("qs-linha-selecionada"));
  quebraStringBytesView.querySelectorAll(".quebra-string-byte.sel").forEach((s) => s.classList.remove("sel"));
  if (!linhas.length) return;
  linhas.forEach((tr) => tr.classList.add("qs-linha-selecionada"));
  const { inicioByte, fimByte } = linhas[0].dataset;
  for (let i = Number(inicioByte); i < Number(fimByte); i++) {
    const s = quebraStringBytesView.querySelector(`[data-byte-index="${i}"]`);
    if (s) s.classList.add("sel");
  }
  linhas[0].scrollIntoView({ block: "center", behavior: "smooth" });
});

// Cor do valor final: ok (verde), neutro (cinza), alerta (amarelo), perigo (vermelho).
function quebraStringTom(chave, final) {
  const t = String(final);
  switch (chave) {
    case "ignicao":
      return /^Ligada/.test(t) ? "ok" : "neutro";
    case "gpsFixo":
      return /^(Inválida|Não|Sem fix|GPS não)/.test(t) ? "alerta" : "ok";
    case "corteOleo":
      return /^Cortado/.test(t) ? "perigo" : "ok";
    case "alarme":
      return /^(Normal|Nenhum)/.test(t) ? "neutro" : "perigo";
    case "backup":
      return /^Sim/.test(t) ? "alerta" : "neutro";
    default:
      return null;
  }
}

// Nível de bateria em % (0-100) quando dá pra inferir do texto; null quando não.
function quebraStringNivelBateria(final) {
  const t = String(final);
  const pct = t.match(/^(\d+(?:[.,]\d+)?)\s*%/);
  if (pct) return Math.min(100, parseFloat(pct[1].replace(",", ".")));
  const nivel = GT06_NIVEL_BATERIA.indexOf(t);
  return nivel >= 0 ? Math.round((nivel / (GT06_NIVEL_BATERIA.length - 1)) * 100) : null;
}

// perfil = chave de QUEBRA_STRING_PERFIS; sem perfil (nada colado ou equipamento não reconhecido) não há tabela.
// Monta e registra (pro clique/hover nos bytes) uma linha da tabela. "campo" pode faltar
// (linha fixa sem valor nessa string) ou vir de uma linha dinâmica (ver "linhasExtras",
// usado pelos elementos de I/O do Teltonika, que mudam de equipamento pra equipamento).
// "chave" é opcional: só afeta o badge colorido (ignição, alarme...) e a barra de bateria.
function criarLinhaQuebraStringTabela(tbody, label, campo, chave) {
  campo = campo || {};
  const tr = document.createElement("tr");
  const temValor = !!campo.final;
  // Linha sem informação nessa string fica apagada, pra o olho ir direto no que veio.
  if (!temValor) tr.classList.add("qs-linha-vazia");

  const tdLabel = document.createElement("td");
  tdLabel.textContent = label;

  const tdBruto = document.createElement("td");
  tdBruto.textContent = campo.bruto ? campo.bruto : "-";

  const tdFinal = document.createElement("td");
  if (!temValor) {
    tdFinal.textContent = "-";
  } else {
    const valor = String(campo.final);
    const tom = quebraStringTom(chave, valor);
    const nivel = chave === "bateria" ? quebraStringNivelBateria(valor) : null;
    const span = document.createElement("span");
    span.textContent = valor;
    if (tom) span.className = `qs-badge qs-${tom}`;
    tdFinal.appendChild(span);

    if (nivel !== null) {
      const barra = document.createElement("span");
      barra.className = "qs-bateria";
      barra.title = `${nivel}%`;
      const preenchido = document.createElement("span");
      preenchido.style.width = `${nivel}%`;
      preenchido.className = nivel <= 20 ? "qs-perigo" : nivel <= 50 ? "qs-alerta" : "qs-ok";
      barra.appendChild(preenchido);
      tdFinal.appendChild(barra);
    }
  }

  if (campo.inicioByte !== undefined) {
    tdBruto.classList.add("quebra-string-bruto-ativo");
    tdBruto.addEventListener("mouseenter", () => destacarBytes(campo.inicioByte, campo.fimByte, true));
    tdBruto.addEventListener("mouseleave", () => destacarBytes(campo.inicioByte, campo.fimByte, false));
    tr.dataset.inicioByte = String(campo.inicioByte);
    tr.dataset.fimByte = String(campo.fimByte);
    for (let i = campo.inicioByte; i < campo.fimByte; i++) {
      if (!quebraStringLinhasPorByte.has(i)) quebraStringLinhasPorByte.set(i, []);
      quebraStringLinhasPorByte.get(i).push(tr);
    }
  }

  tr.appendChild(tdLabel);
  tr.appendChild(tdBruto);
  tr.appendChild(tdFinal);
  tbody.appendChild(tr);
}

// linhasExtras = linhas dinâmicas (fora do esquema fixo de QUEBRA_STRING_CAMPOS), uma por
// elemento de I/O do Teltonika encontrado no pacote: [{ label, bruto, final, inicioByte, fimByte, chave? }].
function renderQuebraStringResultado(campos, aviso, perfil, linhasExtras) {
  quebraStringResultado.innerHTML = "";

  if (aviso) {
    const p = document.createElement("p");
    p.className = "quebra-string-aviso";
    p.textContent = aviso;
    quebraStringResultado.appendChild(p);
  }

  const chavesPerfil = QUEBRA_STRING_PERFIS[perfil];
  if (!chavesPerfil) return;

  // "Ver posição no mapa": barra fina colada no topo da tabela, como ação do resultado. Só aparece
  // quando a string trouxe latitude e longitude (e não é o 0,0 de GPS sem posição).
  const coord = (campo) => {
    const n = campo && campo.final ? parseFloat(String(campo.final).replace(",", ".")) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const lat = coord(campos.latitude);
  const lon = coord(campos.longitude);
  if (lat !== null && lon !== null && !(lat === 0 && lon === 0)) {
    const barra = document.createElement("div");
    barra.className = "quebra-string-tabela-barra";
    const link = document.createElement("a");
    link.className = "quebra-string-mapa";
    link.href = `https://www.google.com/maps?q=${lat},${lon}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = `Abre no Google Maps a posição decodificada (${campos.latitude.final}; ${campos.longitude.final})`;
    link.textContent = "📍 Ver posição no mapa ↗";
    barra.appendChild(link);
    quebraStringResultado.appendChild(barra);
  }

  const tabela = document.createElement("table");
  tabela.className = "tabela-saida quebra-string-tabela";

  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>#</th><th>Dado Bruto</th><th>Informação Decodificada</th></tr>";
  tabela.appendChild(thead);

  const tbody = document.createElement("tbody");
  quebraStringLinhasPorByte = new Map();

  QUEBRA_STRING_CAMPOS.filter(({ chave }) => chavesPerfil.includes(chave)).forEach(({ chave, label }) => {
    criarLinhaQuebraStringTabela(tbody, label, campos[chave], chave);
  });

  (linhasExtras || []).forEach(({ label, bruto, final, inicioByte, fimByte, chave }) => {
    criarLinhaQuebraStringTabela(tbody, label, { bruto, final, inicioByte, fimByte }, chave);
  });

  tabela.appendChild(tbody);
  quebraStringResultado.appendChild(tabela);
}

// Estado inicial da tela (orientação no lugar da tabela). O que a pessoa colou fica
// guardado ao sair e voltar pra sub-tela.
renderQuebraStringResultado({});

// A faixa de bytes trava no topo e o cabeçalho da tabela trava logo abaixo dela;
// como a altura da faixa varia com a string, ela é medida e passada pro CSS.
new ResizeObserver(() => {
  quebraStringBytesView.parentElement.style.setProperty("--qs-topo", `${quebraStringBytesView.offsetHeight}px`);
}).observe(quebraStringBytesView);

const btnQuebraStringLimpar = el("btn-quebra-string-limpar");

function atualizarBotoesQuebraString() {
  const vazio = !quebraStringInput.value.trim();
  btnQuebraString.disabled = vazio;
  btnQuebraStringLimpar.disabled = vazio && !quebraStringBytesView.childElementCount;
}

quebraStringInput.addEventListener("input", atualizarBotoesQuebraString);


btnQuebraStringLimpar.addEventListener("click", () => {
  quebraStringInput.value = "";
  quebraStringBytesView.innerHTML = "";
  renderQuebraStringResultado({});
  atualizarBotoesQuebraString();
  quebraStringInput.focus();
});

function executarQuebraString() {
  const { campos, bytes, aviso, separador, perfil, linhasExtras } = quebrarString(quebraStringInput.value);
  renderQuebraStringBytes(bytes, separador);
  renderQuebraStringResultado(campos, aviso, perfil, linhasExtras);
  atualizarBotoesQuebraString();
}

btnQuebraString.addEventListener("click", executarQuebraString);
// Ctrl+Enter no campo também quebra a string.
quebraStringInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey && quebraStringInput.value.trim()) {
    e.preventDefault();
    executarQuebraString();
  }
});

// --- VALIDADOR DE PLANILHA DE IMPORTAÇÃO (Ferramentas Auxiliares) ---
// A importação da SSX é posicional (a planilha tem que seguir a ORDEM oficial
// do layout do manual, com todas as posições presentes mesmo quando o campo
// não é obrigatório) — por isso o mapeamento aqui é por ORDEM da coluna, não
// pelo nome do cabeçalho.
const overlayValidador = el("overlay-validador");
const validadorTipoSelect = el("validador-tipo");
const validadorInputArquivo = el("validador-input-arquivo");
const validadorArquivoNome = el("validador-arquivo-nome");
const validadorContagemColunas = el("validador-contagem-colunas");
const validadorMapaCampos = el("validador-mapa-campos");
const btnValidadorRodar = el("btn-validador-rodar");
const validadorResultado = el("validador-resultado");

const VALIDADOR_CATEGORIA_LABEL = {
  campo_nao_informado: "Campo não informado",
  tamanho_incorreto: "Tamanho incorreto",
  formato_incorreto: "Formato incorreto",
  inconsistencia: "Inconsistência",
  duplicidade: "Duplicidade",
  digito_verificador: "Dígito verificador inválido",
  atencao: "Atenção",
};

let validadorTiposCarregados = false;
let validadorCamposAtuais = [];
let validadorColunas = [];
let validadorFileId = null;

function mostrarErroValidador(msg) {
  validadorResultado.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  validadorResultado.appendChild(p);
}

async function carregarValidadorTipos() {
  const r = await fetch("/api/validador/tipos");
  const data = await parseJsonResponse(r);
  if (!data.ok) return mostrarErroValidador(data.error || "Falha ao carregar tipos.");
  validadorTipoSelect.innerHTML = "";
  (data.tipos || []).forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.chave;
    opt.textContent = t.titulo;
    validadorTipoSelect.appendChild(opt);
  });
  validadorTiposCarregados = true;
}

function renderValidadorMapaCampos() {
  validadorMapaCampos.innerHTML = "";
  validadorCamposAtuais.forEach((campo, indice) => {
    const linha = document.createElement("div");
    linha.className = "mapa-linha";

    const posicao = document.createElement("span");
    posicao.className = "campo-nome";
    posicao.style.flex = "0 0 34px";
    posicao.textContent = indice + 1;

    const nome = document.createElement("span");
    nome.className = "campo-nome";
    const marcador = campo.obrigatorio === true ? " *" : campo.obrigatorio === "condicional" ? " (condicional)" : "";
    nome.textContent = campo.rotulo + marcador;
    nome.title = campo.chave;

    const coluna = document.createElement("span");
    coluna.className = "campo-nome";
    coluna.textContent = validadorColunas[indice] !== undefined
      ? `→ ${validadorColunas[indice]}`
      : "→ (sem coluna nessa posição)";
    if (validadorColunas[indice] === undefined) coluna.style.color = "#b91c1c";

    linha.appendChild(posicao);
    linha.appendChild(nome);
    linha.appendChild(coluna);
    validadorMapaCampos.appendChild(linha);
  });
}

function atualizarContagemColunas() {
  if (validadorColunas.length === 0 || validadorCamposAtuais.length === 0) {
    validadorContagemColunas.classList.add("hidden");
    return;
  }
  const esperado = validadorCamposAtuais.length;
  const recebido = validadorColunas.length;
  validadorContagemColunas.classList.remove("hidden");
  validadorContagemColunas.textContent = `Sua planilha tem ${recebido} coluna(s); o layout de ${validadorTipoSelect.selectedOptions[0]?.textContent || "importação"} tem ${esperado}.`;
  validadorContagemColunas.style.color = recebido === esperado ? "" : "#b91c1c";
}

async function carregarValidadorCampos(tipo) {
  const r = await fetch(`/api/validador/campos/${tipo}`);
  const data = await parseJsonResponse(r);
  if (!data.ok) return mostrarErroValidador(data.error || "Tipo desconhecido.");
  validadorCamposAtuais = data.campos;
  renderValidadorMapaCampos();
  atualizarContagemColunas();
}

async function abrirModalValidador() {
  validadorFileId = null;
  validadorColunas = [];
  validadorInputArquivo.value = "";
  validadorArquivoNome.textContent = "Nenhum arquivo selecionado";
  validadorResultado.innerHTML = "";
  validadorContagemColunas.classList.add("hidden");
  btnValidadorRodar.disabled = true;
  btnValidadorRodar.textContent = "Validar planilha";
  overlayValidador.classList.remove("hidden");

  if (!validadorTiposCarregados) await carregarValidadorTipos();
  if (validadorTipoSelect.value) await carregarValidadorCampos(validadorTipoSelect.value);
}

el("card-ferramentas-validador").addEventListener("click", () => {
  abrirModalValidador();
});

el("validador-modal-fechar").addEventListener("click", () => overlayValidador.classList.add("hidden"));

validadorTipoSelect.addEventListener("change", () => {
  if (validadorTipoSelect.value) carregarValidadorCampos(validadorTipoSelect.value);
});

validadorInputArquivo.addEventListener("change", async () => {
  const file = validadorInputArquivo.files[0];
  if (!file) return;
  validadorArquivoNome.textContent = "Enviando...";
  const formData = new FormData();
  formData.append("arquivo", file);
  try {
    const r = await fetch("/api/validador/upload", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      validadorArquivoNome.textContent = "Nenhum arquivo selecionado";
      return mostrarErroValidador(data.error || "Falha ao enviar arquivo.");
    }
    validadorFileId = data.file_id;
    validadorColunas = data.colunas;
    validadorArquivoNome.textContent = `${file.name} (${data.total_linhas} linhas)`;
    renderValidadorMapaCampos();
    atualizarContagemColunas();
    btnValidadorRodar.disabled = false;
  } catch (err) {
    validadorArquivoNome.textContent = "Nenhum arquivo selecionado";
    mostrarErroValidador(String(err));
  }
});

function renderValidadorResultado(data) {
  validadorResultado.innerHTML = "";

  const tiles = document.createElement("div");
  tiles.className = "dashboard-tiles";
  [
    { valor: data.total_linhas, label: "Linhas na planilha" },
    { valor: data.linhas_com_erro, label: "Linhas com problema" },
    { valor: data.total_erros, label: "Problemas encontrados" },
  ].forEach(({ valor, label }) => {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const tileLabel = document.createElement("div");
    tileLabel.className = "stat-tile-label";
    tileLabel.textContent = label;
    const tileValor = document.createElement("div");
    tileValor.className = "stat-tile-valor";
    tileValor.textContent = valor;
    tile.appendChild(tileLabel);
    tile.appendChild(tileValor);
    tiles.appendChild(tile);
  });
  validadorResultado.appendChild(tiles);

  if (data.erros.length === 0) {
    const ok = document.createElement("p");
    ok.className = "resumo-final";
    ok.textContent = "Nenhum problema encontrado.";
    validadorResultado.appendChild(ok);
    return;
  }

  const titulo = document.createElement("h4");
  titulo.textContent = `Problemas encontrados (${data.erros.length})`;
  validadorResultado.appendChild(titulo);

  const table = document.createElement("table");
  table.className = "tabela-saida";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Linha</th><th>Campo</th><th>Tipo</th><th>Mensagem</th></tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  data.erros.forEach((erro) => {
    const tr = document.createElement("tr");
    [erro.linha, erro.campo, VALIDADOR_CATEGORIA_LABEL[erro.categoria] || erro.categoria, erro.mensagem].forEach((texto) => {
      const td = document.createElement("td");
      td.textContent = texto;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  validadorResultado.appendChild(table);
}

btnValidadorRodar.addEventListener("click", async () => {
  btnValidadorRodar.disabled = true;
  btnValidadorRodar.textContent = "Validando...";
  validadorResultado.innerHTML = "";

  try {
    const r = await fetch("/api/validador/rodar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo: validadorTipoSelect.value, file_id: validadorFileId }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) throw new Error(data.error || "Falha ao validar planilha.");
    renderValidadorResultado(data);
  } catch (err) {
    mostrarErroValidador(String(err));
  } finally {
    btnValidadorRodar.disabled = false;
    btnValidadorRodar.textContent = "Validar planilha";
  }
});

// --- COMANDOS DE RASTREADORES (Ferramentas > Comandos) ---
const overlayComandos = el("overlay-comandos");
const comandosSelectModelo = el("comandos-select-modelo");
const btnComandosNovoModelo = el("btn-comandos-novo-modelo");
const btnComandosRenomearModelo = el("btn-comandos-renomear-modelo");
const btnComandosExcluirModelo = el("btn-comandos-excluir-modelo");
const formComandosModelo = el("form-comandos-modelo");
const inputComandosModeloNome = el("comandos-modelo-nome");
const btnComandosModeloCancelar = el("btn-comandos-modelo-cancelar");
const comandosPlaceholder = el("comandos-placeholder");
const comandosListaBloco = el("comandos-lista-bloco");
const comandosListaItens = el("comandos-lista-itens");
const formComandoItem = el("form-comando-item");
const inputComandoItemNome = el("comando-item-nome");
const inputComandoItemComando = el("comando-item-comando");
const btnSalvarComandoItem = el("btn-salvar-comando-item");
const btnCancelarEdicaoComandoItem = el("btn-cancelar-edicao-comando-item");
const comandosItemFormTitulo = el("comandos-item-form-titulo");

let comandosModelosCache = [];
let comandosItensCache = [];
let comandosEditandoModeloId = null; // null = criando modelo novo
let comandosEditandoItemId = null; // null = criando comando novo

async function carregarComandosModelos() {
  const r = await fetch("/api/comando-modelos");
  const data = await parseJsonResponse(r);
  if (!data.ok) return mostrarErro(data.error || "Falha ao carregar modelos.");
  comandosModelosCache = data.modelos || [];
  renderComandosSelectModelo();
}

function renderComandosSelectModelo() {
  const atual = comandosSelectModelo.value;
  comandosSelectModelo.innerHTML = '<option value="">Selecione um modelo...</option>';
  comandosModelosCache
    .slice()
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
    .forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.nome;
      comandosSelectModelo.appendChild(opt);
    });
  comandosSelectModelo.value = comandosModelosCache.some((m) => m.id === atual) ? atual : "";
  atualizarComandosBotoesModelo();
}

function atualizarComandosBotoesModelo() {
  const temModelo = !!comandosSelectModelo.value;
  btnComandosRenomearModelo.disabled = !temModelo;
  btnComandosExcluirModelo.disabled = !temModelo;
}

async function carregarComandosItens() {
  const r = await fetch("/api/comando-itens");
  const data = await parseJsonResponse(r);
  if (!data.ok) return mostrarErro(data.error || "Falha ao carregar comandos.");
  comandosItensCache = data.itens || [];
  renderComandosLista();
}

function renderComandosLista() {
  const modeloId = comandosSelectModelo.value;
  if (!modeloId) {
    comandosListaBloco.classList.add("hidden");
    comandosPlaceholder.classList.remove("hidden");
    return;
  }
  comandosPlaceholder.classList.add("hidden");
  comandosListaBloco.classList.remove("hidden");

  const itens = comandosItensCache.filter((i) => i.modeloId === modeloId);
  comandosListaItens.innerHTML = "";

  if (itens.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nenhum comando cadastrado para este modelo ainda.";
    comandosListaItens.appendChild(p);
    return;
  }

  const table = document.createElement("table");
  table.className = "tabela-credenciais";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Nome</th><th>Comando</th><th></th></tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  itens
    .slice()
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
    .forEach((item) => {
      const tr = document.createElement("tr");

      const tdNome = document.createElement("td");
      tdNome.textContent = item.nome;

      const tdComando = document.createElement("td");
      tdComando.textContent = item.comando;
      tdComando.className = "comando-item-valor";

      const tdAcoes = document.createElement("td");
      tdAcoes.className = "acoes-credencial";

      const btnEditar = document.createElement("button");
      btnEditar.textContent = "Editar";
      btnEditar.className = "btn-secondary";
      btnEditar.addEventListener("click", () => abrirEdicaoComandoItem(item));

      const btnExcluir = document.createElement("button");
      btnExcluir.textContent = "Excluir";
      btnExcluir.className = "btn-secondary";
      btnExcluir.addEventListener("click", () => excluirComandoItem(item.id));

      tdAcoes.appendChild(btnEditar);
      tdAcoes.appendChild(btnExcluir);

      tr.appendChild(tdNome);
      tr.appendChild(tdComando);
      tr.appendChild(tdAcoes);
      tbody.appendChild(tr);
    });
  table.appendChild(tbody);
  comandosListaItens.appendChild(table);
}

function resetFormComandoItem() {
  formComandoItem.reset();
  comandosEditandoItemId = null;
  btnSalvarComandoItem.textContent = "Adicionar";
  btnCancelarEdicaoComandoItem.classList.add("hidden");
  comandosItemFormTitulo.textContent = "Adicionar comando";
}

function abrirEdicaoComandoItem(item) {
  inputComandoItemNome.value = item.nome;
  inputComandoItemComando.value = item.comando;
  comandosEditandoItemId = item.id;
  btnSalvarComandoItem.textContent = "Salvar edição";
  btnCancelarEdicaoComandoItem.classList.remove("hidden");
  comandosItemFormTitulo.textContent = "Editar comando";
  inputComandoItemNome.focus();
}

btnCancelarEdicaoComandoItem.addEventListener("click", resetFormComandoItem);

formComandoItem.addEventListener("submit", async (e) => {
  e.preventDefault();
  const modeloId = comandosSelectModelo.value;
  if (!modeloId) return;
  const payload = {
    modeloId,
    nome: inputComandoItemNome.value.trim(),
    comando: inputComandoItemComando.value.trim(),
  };
  if (!payload.nome || !payload.comando) return;
  try {
    const url = comandosEditandoItemId ? `/api/comando-itens/${comandosEditandoItemId}` : "/api/comando-itens";
    const method = comandosEditandoItemId ? "PUT" : "POST";
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErro(data.error || "Falha ao salvar comando.");
    resetFormComandoItem();
    await carregarComandosItens();
  } catch (err) {
    mostrarErro(String(err));
  }
});

async function excluirComandoItem(id) {
  if (!confirm("Excluir este comando?")) return;
  const r = await fetch(`/api/comando-itens/${id}`, { method: "DELETE" });
  const data = await parseJsonResponse(r);
  if (!data.ok) return mostrarErro(data.error || "Falha ao excluir.");
  await carregarComandosItens();
}

function resetFormComandosModelo() {
  formComandosModelo.reset();
  formComandosModelo.classList.add("hidden");
  comandosEditandoModeloId = null;
}

btnComandosNovoModelo.addEventListener("click", () => {
  formComandosModelo.reset();
  comandosEditandoModeloId = null;
  formComandosModelo.classList.remove("hidden");
  inputComandosModeloNome.focus();
});

btnComandosRenomearModelo.addEventListener("click", () => {
  const modelo = comandosModelosCache.find((m) => m.id === comandosSelectModelo.value);
  if (!modelo) return;
  inputComandosModeloNome.value = modelo.nome;
  comandosEditandoModeloId = modelo.id;
  formComandosModelo.classList.remove("hidden");
  inputComandosModeloNome.focus();
});

btnComandosModeloCancelar.addEventListener("click", resetFormComandosModelo);

formComandosModelo.addEventListener("submit", async (e) => {
  e.preventDefault();
  const nome = inputComandosModeloNome.value.trim();
  if (!nome) return;
  try {
    const url = comandosEditandoModeloId ? `/api/comando-modelos/${comandosEditandoModeloId}` : "/api/comando-modelos";
    const method = comandosEditandoModeloId ? "PUT" : "POST";
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErro(data.error || "Falha ao salvar modelo.");
    const modeloId = data.modelo.id;
    resetFormComandosModelo();
    await carregarComandosModelos();
    comandosSelectModelo.value = modeloId;
    atualizarComandosBotoesModelo();
    renderComandosLista();
  } catch (err) {
    mostrarErro(String(err));
  }
});

btnComandosExcluirModelo.addEventListener("click", async () => {
  const modeloId = comandosSelectModelo.value;
  const modelo = comandosModelosCache.find((m) => m.id === modeloId);
  if (!modelo) return;
  if (!confirm(`Excluir o modelo "${modelo.nome}" e todos os comandos cadastrados nele?`)) return;
  const r = await fetch(`/api/comando-modelos/${modeloId}`, { method: "DELETE" });
  const data = await parseJsonResponse(r);
  if (!data.ok) return mostrarErro(data.error || "Falha ao excluir modelo.");
  await carregarComandosModelos();
  await carregarComandosItens();
});

comandosSelectModelo.addEventListener("change", () => {
  atualizarComandosBotoesModelo();
  resetFormComandoItem();
  renderComandosLista();
});

el("btn-abrir-comandos-modelos").addEventListener("click", () => {
  overlayComandos.classList.remove("hidden");
  resetFormComandosModelo();
  resetFormComandoItem();
  comandosSelectModelo.value = "";
  atualizarComandosBotoesModelo();
  renderComandosLista();
  carregarComandosModelos();
  carregarComandosItens();
});

el("comandos-modal-fechar").addEventListener("click", () => overlayComandos.classList.add("hidden"));

// --- USUÁRIOS DA FERRAMENTA (login próprio do app, não confundir com "Logins salvos" da SSX) ---
const overlayUsuarios = el("overlay-usuarios");
const listaUsuarios = el("lista-usuarios");
const formNovoUsuario = el("form-novo-usuario");
const inputUsuarioNome = el("usuario-nome");
const inputUsuarioSenha = el("usuario-senha");
const inputUsuarioTipoAcesso = el("usuario-tipo-acesso");
const inputUsuarioArea = el("usuario-area");
const inputUsuarioResponsavel = el("usuario-responsavel");
const btnSalvarUsuario = el("btn-salvar-usuario");
const btnCancelarEdicaoUsuario = el("btn-cancelar-edicao-usuario");
const usuarioFormTitulo = el("usuario-form-titulo");
const btnGerenciarUsuarios = el("btn-gerenciar-usuarios");

let usuariosCache = [];
let editandoUsuarioId = null;

const TIPO_ACESSO_LABELS = { adm: "Administrador", analista: "Analista", visualizacao: "Visualização" };

// Erro dentro do próprio modal — mostrarErro() escreve na área principal, que
// fica atrás do overlay, e a falha passava despercebida ("não faz nada").
const usuariosErro = el("usuarios-erro");
function mostrarErroUsuarios(msg) {
  usuariosErro.textContent = msg ? "Erro: " + msg : "";
  usuariosErro.classList.toggle("hidden", !msg);
}

async function carregarAppUsuarios() {
  try {
    const r = await fetch("/api/app-usuarios");
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroUsuarios(data.error || "Falha ao carregar usuários.");
    usuariosCache = data.usuarios || [];
    renderListaUsuarios();
  } catch (err) {
    mostrarErroUsuarios(String(err));
  }
}

function renderListaUsuarios() {
  listaUsuarios.innerHTML = "";
  if (usuariosCache.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nenhum usuário cadastrado ainda.";
    listaUsuarios.appendChild(p);
    return;
  }

  const table = document.createElement("table");
  table.className = "tabela-credenciais";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Usuário</th><th>Tipo de acesso</th><th>Área</th><th>Responsável</th><th></th></tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  usuariosCache
    .slice()
    // Doc sem "usuario" (ex.: criado à mão no console do Firestore) quebrava
    // o sort e a lista inteira não aparecia.
    .sort((a, b) => String(a.usuario || "").localeCompare(String(b.usuario || ""), "pt-BR"))
    .forEach((u) => {
      const tr = document.createElement("tr");

      const tdNome = document.createElement("td");
      tdNome.textContent = u.usuario || "(sem nome)";

      const tdTipoAcesso = document.createElement("td");
      tdTipoAcesso.textContent = TIPO_ACESSO_LABELS[u.perfil] || u.perfil;

      const tdArea = document.createElement("td");
      tdArea.textContent = u.area || "-";

      const tdResponsavel = document.createElement("td");
      tdResponsavel.textContent = u.nome_responsavel || "-";

      const tdAcoes = document.createElement("td");
      tdAcoes.className = "acoes-credencial";

      const btnEditar = document.createElement("button");
      btnEditar.textContent = "Editar";
      btnEditar.className = "btn-secondary";
      btnEditar.addEventListener("click", () => abrirEdicaoUsuario(u));

      const btnExcluir = document.createElement("button");
      btnExcluir.textContent = "Excluir";
      btnExcluir.className = "btn-secondary";
      btnExcluir.addEventListener("click", () => excluirAppUsuario(u.id));

      tdAcoes.appendChild(btnEditar);
      tdAcoes.appendChild(btnExcluir);

      tr.appendChild(tdNome);
      tr.appendChild(tdTipoAcesso);
      tr.appendChild(tdArea);
      tr.appendChild(tdResponsavel);
      tr.appendChild(tdAcoes);
      tbody.appendChild(tr);
    });
  table.appendChild(tbody);
  listaUsuarios.appendChild(table);
}

function resetFormUsuario() {
  formNovoUsuario.reset();
  editandoUsuarioId = null;
  inputUsuarioSenha.placeholder = "Senha";
  inputUsuarioSenha.required = true;
  inputUsuarioTipoAcesso.value = "analista";
  inputUsuarioArea.value = "";
  btnSalvarUsuario.textContent = "Adicionar";
  btnCancelarEdicaoUsuario.classList.add("hidden");
  usuarioFormTitulo.textContent = "Adicionar usuário";
}

function abrirEdicaoUsuario(u) {
  inputUsuarioNome.value = u.usuario;
  inputUsuarioSenha.value = "";
  inputUsuarioSenha.placeholder = "Senha (deixe em branco pra manter)";
  inputUsuarioSenha.required = false;
  inputUsuarioTipoAcesso.value = u.perfil || "analista";
  // Área antiga fora da lista atual (ex.: "CS") não tem <option> — sem isso
  // o select caía em "Sem área definida" e salvar apagava a área do usuário.
  inputUsuarioArea.querySelectorAll("option[data-legado]").forEach((o) => o.remove());
  if (u.area && ![...inputUsuarioArea.options].some((o) => o.value === u.area)) {
    const opt = new Option(`${u.area} (antiga)`, u.area);
    opt.dataset.legado = "1";
    inputUsuarioArea.add(opt);
  }
  inputUsuarioArea.value = u.area || "";
  inputUsuarioResponsavel.value = u.nome_responsavel || "";
  editandoUsuarioId = u.id;
  btnSalvarUsuario.textContent = "Salvar edição";
  btnCancelarEdicaoUsuario.classList.remove("hidden");
  usuarioFormTitulo.textContent = "Editar usuário";
  inputUsuarioNome.focus();
}

btnCancelarEdicaoUsuario.addEventListener("click", resetFormUsuario);

formNovoUsuario.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    usuario: inputUsuarioNome.value.trim(),
    senha: inputUsuarioSenha.value,
    perfil: inputUsuarioTipoAcesso.value,
    area: inputUsuarioArea.value,
    nome_responsavel: inputUsuarioResponsavel.value,
  };
  if (!payload.usuario) return;
  if (!editandoUsuarioId && !payload.senha) return;
  try {
    const url = editandoUsuarioId ? `/api/app-usuarios/${editandoUsuarioId}` : "/api/app-usuarios";
    const method = editandoUsuarioId ? "PUT" : "POST";
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroUsuarios(data.error || "Falha ao salvar usuário.");
    mostrarErroUsuarios("");
    resetFormUsuario();
    await carregarAppUsuarios();
  } catch (err) {
    mostrarErroUsuarios(String(err));
  }
});

async function excluirAppUsuario(id) {
  if (!confirm("Excluir este usuário?")) return;
  try {
    const r = await fetch(`/api/app-usuarios/${id}`, { method: "DELETE" });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErroUsuarios(data.error || "Falha ao excluir.");
    mostrarErroUsuarios("");
    await carregarAppUsuarios();
  } catch (err) {
    mostrarErroUsuarios(String(err));
  }
}

// --- MENU DA ENGRENAGEM (perfil / usuários) ---
const btnAppMenu = el("btn-app-menu");
const appMenuDropdown = el("app-menu-dropdown");

btnAppMenu.addEventListener("click", (e) => {
  e.stopPropagation();
  appMenuDropdown.classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!appMenuDropdown.classList.contains("hidden") && !appMenuDropdown.contains(e.target)) {
    appMenuDropdown.classList.add("hidden");
  }
});

if (btnGerenciarUsuarios) {
  btnGerenciarUsuarios.addEventListener("click", () => {
    appMenuDropdown.classList.add("hidden");
    resetFormUsuario();
    mostrarErroUsuarios("");
    overlayUsuarios.classList.remove("hidden");
    carregarAppUsuarios();
  });
}
el("usuarios-fechar").addEventListener("click", () => overlayUsuarios.classList.add("hidden"));

// --- MINHA SENHA (troca a própria senha de acesso à ferramenta) ---
const overlayMinhaSenha = el("overlay-minha-senha");
const formMinhaSenha = el("form-minha-senha");
const inputMinhaSenhaAtual = el("minha-senha-atual");
const inputMinhaSenhaNova = el("minha-senha-nova");
const minhaSenhaMsg = el("minha-senha-msg");

function abrirMinhaSenha() {
  appMenuDropdown.classList.add("hidden");
  overlayMinhaConta.classList.add("hidden");
  formMinhaSenha.reset();
  minhaSenhaMsg.textContent = "";
  overlayMinhaSenha.classList.remove("hidden");
}

el("btn-minha-conta-senha").addEventListener("click", abrirMinhaSenha);
el("minha-senha-fechar").addEventListener("click", () => overlayMinhaSenha.classList.add("hidden"));

el("btn-minha-conta").addEventListener("click", () => {
  appMenuDropdown.classList.add("hidden");
  irParaTela("minha-conta");
});

// --- MODAL DE EDIÇÃO DE "MINHA CONTA" (aberto pela engrenagem da tela) ---
const overlayMinhaConta = el("overlay-minha-conta");
el("btn-minha-conta-editar").addEventListener("click", () => overlayMinhaConta.classList.remove("hidden"));
el("minha-conta-fechar").addEventListener("click", () => overlayMinhaConta.classList.add("hidden"));

formMinhaSenha.addEventListener("submit", async (e) => {
  e.preventDefault();
  minhaSenhaMsg.textContent = "";
  try {
    const r = await fetch("/api/app-usuario/senha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        senha_atual: inputMinhaSenhaAtual.value,
        senha_nova: inputMinhaSenhaNova.value,
      }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      minhaSenhaMsg.textContent = data.error || "Falha ao trocar senha.";
      minhaSenhaMsg.style.color = "#b91c1c";
      return;
    }
    formMinhaSenha.reset();
    minhaSenhaMsg.textContent = "Senha alterada com sucesso.";
    minhaSenhaMsg.style.color = "";
  } catch (err) {
    minhaSenhaMsg.textContent = String(err);
    minhaSenhaMsg.style.color = "#b91c1c";
  }
});

// --- MINHA CONTA (dados pessoais + foto de perfil) ---
const topbarAvatarImg = el("topbar-avatar-img");
const topbarAvatarPlaceholder = el("topbar-avatar-placeholder");
const minhaContaTitulo = el("minha-conta-titulo");
const minhaContaFotoImg = el("minha-conta-foto-img");
const minhaContaFotoPlaceholder = el("minha-conta-foto-placeholder");
const minhaContaMsg = el("minha-conta-msg");
const formMinhaConta = el("form-minha-conta");
// Guarda a foto (data URL já redimensionada) escolhida na tela, separado do
// que já está salvo — só vai pro banco quando o formulário é enviado.
let fotoMinhaContaAtual = "";

function aplicarFotoNoTopbar(foto) {
  const temFoto = !!foto;
  topbarAvatarImg.src = foto || "";
  topbarAvatarImg.classList.toggle("hidden", !temFoto);
  topbarAvatarPlaceholder.classList.toggle("hidden", temFoto);
}

const minhaContaAvatarHubImg = el("minha-conta-avatar-hub-img");
const minhaContaAvatarHubPlaceholder = el("minha-conta-avatar-hub-placeholder");

function aplicarFotoNaTelaConta(foto) {
  const temFoto = !!foto;
  minhaContaFotoImg.src = foto || "";
  minhaContaFotoImg.classList.toggle("hidden", !temFoto);
  minhaContaFotoPlaceholder.classList.toggle("hidden", temFoto);
  minhaContaAvatarHubImg.src = foto || "";
  minhaContaAvatarHubImg.classList.toggle("hidden", !temFoto);
  minhaContaAvatarHubPlaceholder.classList.toggle("hidden", temFoto);
}

function atualizarTituloMinhaConta(p) {
  const nomeCompleto = `${p.nome || ""} ${p.sobrenome || ""}`.trim();
  minhaContaTitulo.textContent = nomeCompleto || p.usuario || "";
}

// Não existe campo de "cargo" próprio ainda — usa o perfil de acesso (o que
// mais se aproxima de um cargo hoje) só pra identificação no cabeçalho.
const CARGO_POR_PERFIL = { adm: "Administrador", analista: "Analista", visualizacao: "Visualização" };
el("minha-conta-cargo").textContent = CARGO_POR_PERFIL[USUARIO_PERFIL_ATUAL] || "Analista";

async function carregarMinhaConta() {
  minhaContaMsg.classList.add("hidden");
  try {
    const r = await fetch("/api/app-usuario/perfil");
    const data = await parseJsonResponse(r);
    if (!data.ok) return;
    const p = data.perfil;
    el("minha-conta-nome").value = p.nome || "";
    el("minha-conta-sobrenome").value = p.sobrenome || "";
    const [mes, dia] = (p.aniversario || "").split("-");
    el("minha-conta-aniversario-dia").value = dia || "";
    el("minha-conta-aniversario-mes").value = mes || "";
    el("minha-conta-aniversario-banner").classList.toggle("hidden", !p.aniversario_hoje);
    el("minha-conta-login").value = p.usuario || "";
    el("minha-conta-telefone").value = p.telefone_profissional || "";
    el("minha-conta-email").value = p.email || "";
    fotoMinhaContaAtual = p.foto || "";
    aplicarFotoNaTelaConta(fotoMinhaContaAtual);
    atualizarTituloMinhaConta(p);
  } catch (err) {
    minhaContaMsg.textContent = String(err);
    minhaContaMsg.style.color = "#b91c1c";
    minhaContaMsg.classList.remove("hidden");
  }
}

// Painel de Tarefas do hub "Minha Conta" mostra só pendentes — concluídas
// ficam atrás do botão "Ver tarefas concluídas" (histórico à parte).
async function carregarMinhasTarefas() {
  const container = el("minha-conta-tarefas-lista");
  container.innerHTML = '<p class="placeholder">Carregando...</p>';
  try {
    const r = await fetch("/api/tarefas?apenas_minhas=1");
    const data = await parseJsonResponse(r);
    container.innerHTML = "";
    if (!data.ok) {
      const p = document.createElement("p");
      p.className = "placeholder";
      p.textContent = `Erro: ${data.error || "falha ao carregar tarefas"}`;
      container.appendChild(p);
      el("minha-conta-tarefas-contagem").textContent = "0";
      return;
    }
    const pendentes = (data.tarefas || []).filter((t) => !t.concluida);
    el("minha-conta-tarefas-contagem").textContent = String(pendentes.length);
    container.appendChild(construirListaTarefas(pendentes, {
      mostrarCliente: true,
      compacta: true,
      aoMudar: carregarMinhasTarefas,
      aoClicar: (t) => abrirDetalhesTarefa(t, carregarMinhasTarefas),
    }));
  } catch (err) {
    container.innerHTML = "";
  }
}

el("btn-nova-tarefa-minha-conta").addEventListener("click", () => abrirModalTarefa({ aoSalvar: carregarMinhasTarefas }));

// --- CENTRAL DE TAREFAS (Minha Conta) ---
// Junta as tarefas em que sou responsável com as que criei pra outras
// pessoas (acompanhamento). Sempre abre em "Pendentes"; status, responsável
// e "só as que eu criei" filtram em memória, sem buscar de novo.
const centralTarefasStatus = el("central-tarefas-status");
const centralTarefasResponsavel = el("central-tarefas-responsavel");
const centralTarefasSoCriadas = el("central-tarefas-so-criadas");
let centralTarefasCache = [];
let centralTarefasFiltroStatus = "pendentes";

function statusCentralCombina(t, status) {
  if (status === "todas") return true;
  if (status === "pendentes") return !t.concluida;
  return t.concluida && resultadoTarefa(t) === status;
}

function renderizarCentralTarefas() {
  const responsavel = centralTarefasResponsavel.value;
  const soCriadas = centralTarefasSoCriadas.checked;
  // Contagem de cada aba respeita os filtros da direita, só não o de status.
  const base = centralTarefasCache.filter((t) =>
    (!responsavel || t.responsavel_id === responsavel)
    && (!soCriadas || t.criado_por === USUARIO_ID_ATUAL));

  centralTarefasStatus.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("ativo", btn.dataset.status === centralTarefasFiltroStatus);
    btn.querySelector(".central-tarefas-contagem").textContent =
      `(${base.filter((t) => statusCentralCombina(t, btn.dataset.status)).length})`;
  });

  const container = el("central-tarefas-lista");
  container.innerHTML = "";
  container.appendChild(construirListaTarefas(
    base.filter((t) => statusCentralCombina(t, centralTarefasFiltroStatus)),
    {
      mostrarCliente: true,
      mostrarResponsavel: true,
      compacta: true,
      aoMudar: recarregarCentralTarefas,
      aoClicar: (t) => abrirDetalhesTarefa(t, recarregarCentralTarefas),
    },
  ));
}

async function carregarCentralTarefas() {
  const container = el("central-tarefas-lista");
  container.innerHTML = '<p class="placeholder">Carregando...</p>';
  try {
    const r = await fetch("/api/tarefas?minhas_e_criadas=1");
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      container.innerHTML = "";
      const p = document.createElement("p");
      p.className = "placeholder";
      p.textContent = `Erro: ${data.error || "falha ao carregar tarefas"}`;
      container.appendChild(p);
      return;
    }
    // Pendentes por prazo (já vem assim do backend); finalizadas da mais
    // recente pra mais antiga.
    const lista = data.tarefas || [];
    centralTarefasCache = lista.filter((t) => !t.concluida)
      .concat(lista.filter((t) => t.concluida)
        .sort((a, b) => (b.concluida_em || "").localeCompare(a.concluida_em || "")));

    // Opções de responsável = quem aparece nas tarefas carregadas; mantém a
    // escolha atual se ela ainda existir (recarga depois de uma mudança).
    const escolhido = centralTarefasResponsavel.value;
    const nomes = {};
    centralTarefasCache.forEach((t) => {
      if (t.responsavel_id) nomes[t.responsavel_id] = t.responsavel_nome || "(sem nome)";
    });
    centralTarefasResponsavel.innerHTML = '<option value="">Todos os responsáveis</option>';
    Object.entries(nomes)
      .sort((a, b) => a[1].localeCompare(b[1], "pt-BR"))
      .forEach(([id, nome]) => {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = id === USUARIO_ID_ATUAL ? `${nome} (eu)` : nome;
        centralTarefasResponsavel.appendChild(opt);
      });
    centralTarefasResponsavel.value = nomes[escolhido] ? escolhido : "";

    renderizarCentralTarefas();
  } catch (err) {
    container.innerHTML = "";
  }
}

function abrirCentralTarefas() {
  centralTarefasFiltroStatus = "pendentes";
  centralTarefasResponsavel.value = "";
  centralTarefasSoCriadas.checked = false;
  el("overlay-central-tarefas").classList.remove("hidden");
  carregarCentralTarefas();
}

// Mudança feita na central (concluir, cancelar, editar...) também mexe no
// painel de Tarefas do hub, atrás dela.
function recarregarCentralTarefas() { carregarCentralTarefas(); carregarMinhasTarefas(); }

el("btn-central-tarefas").addEventListener("click", abrirCentralTarefas);
el("central-tarefas-fechar").addEventListener("click", () => el("overlay-central-tarefas").classList.add("hidden"));
centralTarefasStatus.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    centralTarefasFiltroStatus = btn.dataset.status;
    renderizarCentralTarefas();
  });
});
centralTarefasResponsavel.addEventListener("change", renderizarCentralTarefas);
centralTarefasSoCriadas.addEventListener("change", renderizarCentralTarefas);

el("minha-conta-foto-btn").addEventListener("click", () => el("minha-conta-foto-input").click());
el("minha-conta-foto-trocar").addEventListener("click", () => el("minha-conta-foto-input").click());

el("minha-conta-foto-input").addEventListener("change", (e) => {
  const arquivo = e.target.files[0];
  e.target.value = "";
  if (!arquivo) return;
  const leitor = new FileReader();
  leitor.onload = () => {
    const img = new Image();
    img.onload = () => abrirCorteFoto(img);
    img.onerror = () => alert("Não foi possível abrir essa imagem.");
    img.src = leitor.result;
  };
  leitor.readAsDataURL(arquivo);
});

// --- AJUSTE DA FOTO DE PERFIL (arrastar + zoom, prévia em círculo) ---
// A imagem é posicionada dentro de um quadrado de FOTO_CORTE_VISOR px; ao
// confirmar, o mesmo enquadramento é redesenhado em FOTO_PERFIL_TAMANHO px e
// vira JPEG base64 — avatar pequeno, evita documento gigante no Firestore.
const FOTO_CORTE_VISOR = 260;
const FOTO_PERFIL_TAMANHO = 200;
const fotoCorteCanvas = el("foto-corte-canvas");
const fotoCorteZoom = el("foto-corte-zoom");
// escalaMin = menor escala que ainda cobre o quadrado inteiro (zoom 1);
// x/y = posição do canto superior esquerdo da imagem dentro do visor.
const fotoCorte = { img: null, escalaMin: 1, escala: 1, x: 0, y: 0 };

function limitarPosicaoFotoCorte() {
  // Nunca deixa aparecer "buraco" (fundo vazio) dentro do quadrado.
  const w = fotoCorte.img.width * fotoCorte.escala;
  const h = fotoCorte.img.height * fotoCorte.escala;
  fotoCorte.x = Math.min(0, Math.max(FOTO_CORTE_VISOR - w, fotoCorte.x));
  fotoCorte.y = Math.min(0, Math.max(FOTO_CORTE_VISOR - h, fotoCorte.y));
}

function desenharFotoCorte(canvas, tamanho) {
  const ctx = canvas.getContext("2d");
  const k = tamanho / FOTO_CORTE_VISOR;
  ctx.fillStyle = "#fff"; // JPEG não tem transparência — PNG transparente fica em fundo branco
  ctx.fillRect(0, 0, tamanho, tamanho);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    fotoCorte.img,
    fotoCorte.x * k, fotoCorte.y * k,
    fotoCorte.img.width * fotoCorte.escala * k, fotoCorte.img.height * fotoCorte.escala * k,
  );
}

function redesenharVisorFotoCorte() {
  const dpr = window.devicePixelRatio || 1;
  fotoCorteCanvas.width = FOTO_CORTE_VISOR * dpr;
  fotoCorteCanvas.height = FOTO_CORTE_VISOR * dpr;
  desenharFotoCorte(fotoCorteCanvas, FOTO_CORTE_VISOR * dpr);
}

function aplicarZoomFotoCorte(zoom, centroX, centroY) {
  // Mantém parado o ponto sob o cursor (ou o centro, pelo slider) enquanto
  // aproxima/afasta — senão a imagem "foge" pro canto ao dar zoom.
  zoom = Math.min(Number(fotoCorteZoom.max), Math.max(1, zoom));
  const cx = centroX ?? FOTO_CORTE_VISOR / 2;
  const cy = centroY ?? FOTO_CORTE_VISOR / 2;
  const novaEscala = fotoCorte.escalaMin * zoom;
  const fator = novaEscala / fotoCorte.escala;
  fotoCorte.x = cx - (cx - fotoCorte.x) * fator;
  fotoCorte.y = cy - (cy - fotoCorte.y) * fator;
  fotoCorte.escala = novaEscala;
  fotoCorteZoom.value = String(zoom);
  limitarPosicaoFotoCorte();
  redesenharVisorFotoCorte();
}

function abrirCorteFoto(img) {
  fotoCorte.img = img;
  fotoCorte.escalaMin = FOTO_CORTE_VISOR / Math.min(img.width, img.height);
  fotoCorte.escala = fotoCorte.escalaMin;
  // Começa centralizado — igual ao corte automático de antes.
  fotoCorte.x = (FOTO_CORTE_VISOR - img.width * fotoCorte.escala) / 2;
  fotoCorte.y = (FOTO_CORTE_VISOR - img.height * fotoCorte.escala) / 2;
  fotoCorteZoom.value = "1";
  redesenharVisorFotoCorte();
  el("overlay-foto-corte").classList.remove("hidden");
}

fotoCorteZoom.addEventListener("input", () => aplicarZoomFotoCorte(Number(fotoCorteZoom.value)));

fotoCorteCanvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = fotoCorteCanvas.getBoundingClientRect();
  const escalaTela = FOTO_CORTE_VISOR / r.width;
  aplicarZoomFotoCorte(
    Number(fotoCorteZoom.value) * (e.deltaY < 0 ? 1.08 : 1 / 1.08),
    (e.clientX - r.left) * escalaTela, (e.clientY - r.top) * escalaTela,
  );
}, { passive: false });

// Pointer events cobrem mouse e toque (celular) com o mesmo código.
let fotoCorteArrasto = null;
fotoCorteCanvas.addEventListener("pointerdown", (e) => {
  fotoCorteCanvas.setPointerCapture(e.pointerId);
  fotoCorteArrasto = { px: e.clientX, py: e.clientY, x: fotoCorte.x, y: fotoCorte.y };
  fotoCorteCanvas.classList.add("arrastando");
});
fotoCorteCanvas.addEventListener("pointermove", (e) => {
  if (!fotoCorteArrasto) return;
  const escalaTela = FOTO_CORTE_VISOR / fotoCorteCanvas.getBoundingClientRect().width;
  fotoCorte.x = fotoCorteArrasto.x + (e.clientX - fotoCorteArrasto.px) * escalaTela;
  fotoCorte.y = fotoCorteArrasto.y + (e.clientY - fotoCorteArrasto.py) * escalaTela;
  limitarPosicaoFotoCorte();
  redesenharVisorFotoCorte();
});
["pointerup", "pointercancel"].forEach((ev) => fotoCorteCanvas.addEventListener(ev, () => {
  fotoCorteArrasto = null;
  fotoCorteCanvas.classList.remove("arrastando");
}));

el("foto-corte-fechar").addEventListener("click", () => {
  el("overlay-foto-corte").classList.add("hidden");
  fotoCorte.img = null;
});

el("btn-foto-corte-aplicar").addEventListener("click", async () => {
  if (!fotoCorte.img) return;
  const canvas = document.createElement("canvas");
  canvas.width = FOTO_PERFIL_TAMANHO;
  canvas.height = FOTO_PERFIL_TAMANHO;
  desenharFotoCorte(canvas, FOTO_PERFIL_TAMANHO);
  const foto = canvas.toDataURL("image/jpeg", 0.85);

  // Grava a foto na hora (endpoint só dela) — assim o topbar já troca, sem
  // depender do "Salvar" do formulário de dados pessoais.
  const btn = el("btn-foto-corte-aplicar");
  btn.disabled = true;
  try {
    const r = await fetch("/api/app-usuario/foto", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foto }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao salvar a foto: ${data.error || "falha desconhecida"}`);
    fotoMinhaContaAtual = foto;
    aplicarFotoNaTelaConta(foto);
    aplicarFotoNoTopbar(foto);
    el("overlay-foto-corte").classList.add("hidden");
    fotoCorte.img = null;
  } catch (err) {
    alert(`Erro ao salvar a foto: ${String(err)}`);
  } finally {
    btn.disabled = false;
  }
});

formMinhaConta.addEventListener("submit", async (e) => {
  e.preventDefault();
  minhaContaMsg.classList.remove("hidden");
  minhaContaMsg.textContent = "Salvando...";
  minhaContaMsg.style.color = "";
  const dia = el("minha-conta-aniversario-dia").value;
  const mes = el("minha-conta-aniversario-mes").value;
  try {
    const r = await fetch("/api/app-usuario/perfil", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nome: el("minha-conta-nome").value.trim(),
        sobrenome: el("minha-conta-sobrenome").value.trim(),
        aniversario: dia && mes ? `${mes}-${dia}` : "",
        telefone_profissional: el("minha-conta-telefone").value.trim(),
        email: el("minha-conta-email").value.trim(),
        foto: fotoMinhaContaAtual,
      }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      minhaContaMsg.textContent = data.error || "Falha ao salvar.";
      minhaContaMsg.style.color = "#b91c1c";
      return;
    }
    minhaContaMsg.textContent = "Dados salvos com sucesso.";
    aplicarFotoNoTopbar(fotoMinhaContaAtual);
    atualizarTituloMinhaConta(data.perfil);
  } catch (err) {
    minhaContaMsg.textContent = String(err);
    minhaContaMsg.style.color = "#b91c1c";
  }
});

// --- TEMA ESCURO ---
const chkTemaEscuro = el("chk-tema-escuro");
chkTemaEscuro.checked = document.documentElement.getAttribute("data-theme") === "dark";
chkTemaEscuro.addEventListener("change", () => {
  if (chkTemaEscuro.checked) {
    document.documentElement.setAttribute("data-theme", "dark");
    localStorage.setItem("tema", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("tema", "claro");
  }
});

// --- SIDEBAR MINIMIZÁVEL ---
const sidebarEl = el("sidebar");
const sidebarToggle = el("sidebar-toggle");

function aplicarEstadoSidebar(recolhida) {
  sidebarEl.classList.toggle("recolhida", recolhida);
  sidebarToggle.title = recolhida ? "Expandir menu" : "Recolher menu";
  sidebarToggle.setAttribute("aria-label", sidebarToggle.title);
  sidebarToggle.setAttribute("aria-expanded", String(!recolhida));
}

aplicarEstadoSidebar(localStorage.getItem("sidebar_state") === "collapsed");

sidebarToggle.addEventListener("click", () => {
  const recolhida = !sidebarEl.classList.contains("recolhida");
  aplicarEstadoSidebar(recolhida);
  localStorage.setItem("sidebar_state", recolhida ? "collapsed" : "expanded");
});

// --- NAVEGAÇÃO PRINCIPAL (Fase 1: Dashboard / Controle de Implantação /
// Controle de Migração / Ferramentas Auxiliares; Fase 3a: Ficha do Cliente) ---
// Cada botão da sidebar só mostra/esconde um dos containers de tela e, quando
// aplicável, chama a MESMA função que a tela antiga já usava pra carregar os
// dados — nenhuma lógica de carregamento foi duplicada ou reescrita aqui.
const TELAS_NAV = {
  dashboard: el("tela-dashboard"),
  implantacao: el("tela-saida-wrapper"),
  migracao: el("tela-saida-wrapper"),
  ferramentas: el("tela-ferramentas"),
  ficha: el("tela-ficha-cliente"),
  "minha-conta": el("tela-minha-conta"),
  feed: el("tela-feed"),
};
const NAV_BOTOES = {
  dashboard: el("nav-dashboard"),
  feed: el("nav-feed"),
  implantacao: el("nav-implantacao"),
  migracao: el("nav-migracao"),
  ferramentas: el("nav-ferramentas"),
};
const sidebarRaiz = el("sidebar-raiz");
const sidebarCliente = el("sidebar-cliente");

// Cada tela raiz tem sua própria URL (o Flask serve o mesmo HTML nas rotas —
// quem decide o que aparece é este arquivo, lendo/escrevendo a URL). A Ficha
// do Cliente usa "/cliente/<idcentral>" (prefixo, não mapa fixo, já que o
// idcentral muda por cliente). É isso que faz o botão Voltar/Avançar do
// navegador funcionar entre as telas em vez de cair direto na tela de login.
const CAMINHO_POR_TELA = {
  dashboard: "/",
  feed: "/feed",
  implantacao: "/implantacao",
  migracao: "/migracao",
  ferramentas: "/ferramentas",
  "minha-conta": "/minha-conta",
};
const TELA_POR_CAMINHO_RAIZ = {
  "/": "dashboard",
  "/feed": "feed",
  "/implantacao": "implantacao",
  "/migracao": "migracao",
  "/ferramentas": "ferramentas",
  "/minha-conta": "minha-conta",
};

// Sub-telas de "Ferramentas Auxiliares" (cards -> Área de Importação e Consulta
// / Envio de Comandos): cada uma tem sua própria URL "/ferramentas/<sub>", igual
// à Ficha do Cliente usa prefixo em vez de mapa fixo pro idcentral.
const FERRAMENTAS_SUBTELAS = {
  "importacao-consulta": el("ferramentas-sub-importacao"),
  "comandos": el("ferramentas-sub-comandos"),
  "sync-planilha": el("ferramentas-sub-sync-planilha"),
  "quebra-string": el("ferramentas-sub-quebra-string"),
  "conversor-kml": el("ferramentas-sub-conversor-kml"),
  "central-importacao": el("ferramentas-sub-central-importacao"),
  "conversor-clientes": el("ferramentas-sub-conversor-clientes"),
  "conversor-veiculos": el("ferramentas-sub-conversor-veiculos"),
  "conversor-rastreadores": el("ferramentas-sub-conversor-rastreadores"),
  "conversor-simcards": el("ferramentas-sub-conversor-simcards"),
  "conversor-areas": el("ferramentas-sub-conversor-areas"),
  "conversor-uo": el("ferramentas-sub-conversor-uo"),
  "conversor-colaboradores": el("ferramentas-sub-conversor-colaboradores"),
  "conversor-viagens": el("ferramentas-sub-conversor-viagens"),
  "conversor-abastecimento": el("ferramentas-sub-conversor-abastecimento"),
  "atalhos": el("ferramentas-sub-atalhos"),
};
// Sub-telas que são "filhas" da Central de Importação SSX — chegam por ela e
// o Voltar do sidebar deve retornar pra lá (não pro grid de Ferramentas
// Auxiliares). "conversor-kml" entrou aqui junto com "conversor-areas": os
// dois cards de Áreas (Planilha e KML) agora vivem dentro da Central, não
// mais soltos no grid raiz de Ferramentas Auxiliares.
const SUBTELAS_FILHAS_DA_CENTRAL_IMPORTACAO = [
  "importacao-consulta", "conversor-clientes", "conversor-veiculos", "conversor-rastreadores", "conversor-simcards",
  "conversor-areas", "conversor-kml", "conversor-uo", "conversor-colaboradores",
  "conversor-viagens", "conversor-abastecimento", "atalhos",
];
const ferramentasCardsHeader = el("ferramentas-cards-header");
const ferramentasCards = el("ferramentas-cards");

function mostrarFerramentasSub(sub) {
  const alvo = FERRAMENTAS_SUBTELAS[sub] || null;
  Object.values(FERRAMENTAS_SUBTELAS).forEach((elemento) => elemento.classList.add("hidden"));
  ferramentasCardsHeader.classList.toggle("hidden", !!alvo);
  ferramentasCards.classList.toggle("hidden", !!alvo);
  if (alvo) alvo.classList.remove("hidden");
}

function resolverCaminho(caminho) {
  const mCliente = caminho.match(/^\/cliente\/([^/]+)$/);
  if (mCliente) return { tela: "ficha", idcentral: decodeURIComponent(mCliente[1]) };
  const mFerramentas = caminho.match(/^\/ferramentas\/([^/]+)$/);
  if (mFerramentas && FERRAMENTAS_SUBTELAS[mFerramentas[1]]) return { tela: "ferramentas", sub: mFerramentas[1] };
  return { tela: TELA_POR_CAMINHO_RAIZ[caminho] || "dashboard" };
}

// Rastreia a tela atual só pra saber quando a navegação está SAINDO da
// sub-tela de login avulso (Importação/Consulta) — dispara a limpeza da
// autenticação nesse momento. É reforço de UX (a garantia de verdade é a
// checagem no backend).
let telaNavAtual = null;
let ferramentasSubAtual = null;
// De onde a Ficha do Cliente foi aberta (Implantação ou Migração) — usado
// pelo botão Voltar da Ficha pra retornar pra lá em vez de sempre cair no
// Dashboard. Guardado também no pushState pra sobreviver ao Voltar/Avançar
// do navegador.
let fichaOrigem = "dashboard";

// Componente padrão: a tela de login avulso (Importação/Consulta) não deve
// deixar essa autenticação viva depois que a pessoa sai da tela — dispara o
// endpoint de "sair" certo e reflete a limpeza no estado local. `estavaLa`/
// `continuaLa` já vêm calculados pelo chamador (precisam comparar com
// telaNavAtual/ferramentasSubAtual ANTES desses valores serem sobrescritos
// pela navegação atual). É reforço de UX — a garantia de verdade é sempre a
// checagem no backend.
function limparAuthSeSaiuDaTela(estavaLa, continuaLa, endpoint, idcentralParaConferir) {
  if (!estavaLa || continuaLa) return;
  fetch(endpoint, { method: "POST" }).catch(() => {});
  if (idcentralParaConferir === undefined || estado.idcentralAutenticado === idcentralParaConferir) {
    aplicarEstadoAuth(false, null);
  }
}

// Liga o layout compacto de Implantação/Migração (ver .tela-lista-compacta no
// CSS) — menos moldura em volta da lista/kanban = mais cards visíveis.
function marcarTelaListaCompacta(naListaCompacta) {
  document.body.classList.toggle("tela-lista-compacta", naListaCompacta);
}

// Minúsculo e sem acento — "sao joao" acha "São João".
function normalizarBusca(texto) {
  return String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

// Campo "Filtrar clientes…" das barras de Implantação/Migração: só filtra a
// lista da tela atual. Ícone de funil de propósito, pra não parecer a busca
// da topbar (que é "ir para o cliente").
function criarCampoFiltroLista(valorInicial, aoMudar) {
  const wrap = document.createElement("label");
  wrap.className = "filtro-lista";
  wrap.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>';
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Filtrar clientes…";
  input.value = valorInicial || "";
  input.addEventListener("input", () => aoMudar(input.value));
  wrap.appendChild(input);
  return wrap;
}

// --- BUSCA GLOBAL DA TOPBAR: "ir para o cliente" ---
// Em qualquer tela: digita, aparece uma lista de clientes, Enter/clique abre a
// Ficha (ou a linha do tempo, se o cliente não tem IdCentral). Nunca filtra a
// página. A lista de clientes é carregada UMA vez, no primeiro foco (ou
// reaproveitada da tela de Implantação), pra não gastar leitura a cada letra.
const topbarBuscaInput = el("topbar-busca-input");
const topbarBuscaResultados = el("topbar-busca-resultados");
let buscaGlobalClientes = null; // null = ainda não carregou
let buscaGlobalCarregando = null;
let buscaGlobalItens = [];
let buscaGlobalIndice = -1;

async function garantirClientesBuscaGlobal() {
  if (buscaGlobalClientes) return buscaGlobalClientes;
  if (implantacaoClientesCache.length) {
    buscaGlobalClientes = implantacaoClientesCache;
    return buscaGlobalClientes;
  }
  if (!buscaGlobalCarregando) {
    buscaGlobalCarregando = fetch("/api/clientes")
      .then(parseJsonResponse)
      .then((data) => { buscaGlobalClientes = data.ok ? (data.clientes || []) : []; return buscaGlobalClientes; })
      .catch(() => [])
      .finally(() => { buscaGlobalCarregando = null; });
  }
  return buscaGlobalCarregando;
}

function fecharBuscaGlobal() {
  topbarBuscaResultados.classList.add("hidden");
  topbarBuscaResultados.innerHTML = "";
  buscaGlobalItens = [];
  buscaGlobalIndice = -1;
}

function abrirResultadoBuscaGlobal(c) {
  topbarBuscaInput.value = "";
  topbarBuscaInput.blur();
  fecharBuscaGlobal();
  abrirClienteOuFicha(c, abrirTimelineImplantacao);
}

function destacarResultadoBuscaGlobal(indice) {
  buscaGlobalIndice = indice;
  topbarBuscaResultados.querySelectorAll(".busca-global-item").forEach((item, i) => {
    item.classList.toggle("ativo", i === indice);
    if (i === indice) item.scrollIntoView({ block: "nearest" });
  });
}

async function renderizarBuscaGlobal() {
  const termo = normalizarBusca(topbarBuscaInput.value);
  if (!termo) return fecharBuscaGlobal();
  topbarBuscaResultados.classList.remove("hidden");
  if (!buscaGlobalClientes) {
    topbarBuscaResultados.innerHTML = '<div class="busca-global-vazio">Carregando clientes…</div>';
  }
  const clientes = await garantirClientesBuscaGlobal();
  // O usuário pode ter apagado o texto enquanto carregava.
  if (normalizarBusca(topbarBuscaInput.value) !== termo) return;

  // Nome que começa com o termo vem antes de nome que só contém.
  buscaGlobalItens = clientes
    .map((c) => {
      const nome = normalizarBusca(c.cliente);
      const id = normalizarBusca(c.idcentral);
      const rank = nome.startsWith(termo) || id === termo ? 0 : (nome.includes(termo) || id.includes(termo) ? 1 : -1);
      return { c, rank };
    })
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || (a.c.cliente || "").localeCompare(b.c.cliente || "", "pt-BR"))
    .slice(0, 8)
    .map((x) => x.c);

  topbarBuscaResultados.innerHTML = "";
  if (buscaGlobalItens.length === 0) {
    topbarBuscaResultados.innerHTML = '<div class="busca-global-vazio">Nenhum cliente encontrado.</div>';
    buscaGlobalIndice = -1;
    return;
  }
  buscaGlobalItens.forEach((c, i) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "busca-global-item";
    const nome = document.createElement("span");
    nome.className = "busca-global-nome";
    nome.textContent = c.cliente || "(sem nome)";
    const meta = document.createElement("span");
    meta.className = "busca-global-meta";
    const etapa = c.etapa === "concluido" ? "Implantado" : nomeCurtoEtapaImplantacao(c.etapa || "marco-1");
    meta.textContent = [c.idcentral ? `ID ${c.idcentral}` : "sem IdCentral", etapa].join(" · ");
    item.appendChild(nome);
    item.appendChild(meta);
    // mousedown (não click): dispara antes do blur do input fechar a lista.
    item.addEventListener("mousedown", (e) => { e.preventDefault(); abrirResultadoBuscaGlobal(c); });
    item.addEventListener("mouseenter", () => destacarResultadoBuscaGlobal(i));
    topbarBuscaResultados.appendChild(item);
  });
  destacarResultadoBuscaGlobal(0);
}

topbarBuscaInput.addEventListener("focus", () => {
  garantirClientesBuscaGlobal();
  if (topbarBuscaInput.value.trim()) renderizarBuscaGlobal();
});
topbarBuscaInput.addEventListener("input", renderizarBuscaGlobal);
topbarBuscaInput.addEventListener("blur", fecharBuscaGlobal);
topbarBuscaInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" && buscaGlobalItens.length) {
    e.preventDefault();
    destacarResultadoBuscaGlobal((buscaGlobalIndice + 1) % buscaGlobalItens.length);
  } else if (e.key === "ArrowUp" && buscaGlobalItens.length) {
    e.preventDefault();
    destacarResultadoBuscaGlobal((buscaGlobalIndice - 1 + buscaGlobalItens.length) % buscaGlobalItens.length);
  } else if (e.key === "Enter" && buscaGlobalItens[buscaGlobalIndice]) {
    e.preventDefault();
    abrirResultadoBuscaGlobal(buscaGlobalItens[buscaGlobalIndice]);
  } else if (e.key === "Escape") {
    topbarBuscaInput.value = "";
    topbarBuscaInput.blur();
  }
});
// Ctrl+K (ou Cmd+K) de qualquer lugar foca a busca.
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    topbarBuscaInput.focus();
    topbarBuscaInput.select();
  }
});

// Título da página fica na topbar (não repetido dentro do painel — os <h2>
// das telas são escondidos via CSS). Subtelas de Ferramentas viram trilha:
// "Ferramentas Auxiliares › Envio de Comandos", com o primeiro nível clicável.
const topbarTitulo = el("topbar-titulo");
const TITULO_TOPBAR_POR_TELA = {
  dashboard: "Dashboard",
  feed: "Feed",
  implantacao: "Controle de Implantação",
  migracao: "Controle de Migração",
  ferramentas: "Ferramentas Auxiliares",
  ficha: "Ficha do cliente",
  "minha-conta": "Minha conta",
};
const TITULO_TOPBAR_POR_SUB = {
  "importacao-consulta": "Área de Importação e Consulta",
  comandos: "Envio de Comandos",
  "sync-planilha": "Sincronizar Planilha",
  "quebra-string": "Quebra-String",
  "conversor-kml": "Conversor KML → SSX",
  "central-importacao": "Central de Importação SSX",
  "conversor-clientes": "Conversor de Clientes → SSX",
  "conversor-veiculos": "Conversor de Veículos → SSX",
  "conversor-rastreadores": "Conversor de Rastreadores → SSX",
  "conversor-simcards": "Conversor de SIM Cards → SSX",
  "conversor-areas": "Planilha de Áreas → SSX",
  "conversor-uo": "Conversor de Unidades Organizacionais → SSX",
  "conversor-colaboradores": "Conversor de Colaboradores → SSX",
  "conversor-viagens": "Conversor de Viagens → SSX",
  "conversor-abastecimento": "Conversor de Abastecimento → SSX",
  "atalhos": "Operações em massa",
};

// Sub-telas de Ferramentas mostram só o próprio nome — a volta pra Ferramentas
// Auxiliares fica no "Voltar" do sidebar.
function atualizarTituloTopbar(tela, sub) {
  const titulo = (tela === "ferramentas" && TITULO_TOPBAR_POR_SUB[sub]) || TITULO_TOPBAR_POR_TELA[tela] || "";
  topbarTitulo.textContent = titulo;
}

function irParaTela(tela, opcoes) {
  opcoes = opcoes || {};

  const novoSub = tela === "ferramentas" && FERRAMENTAS_SUBTELAS[opcoes.sub] ? opcoes.sub : null;

  // /api/logout faz session.clear() de propósito (é o botão "Sair", desloga
  // da ferramenta inteira) — aqui precisa só limpar o token avulso da SSX,
  // por isso o endpoint dedicado.
  limparAuthSeSaiuDaTela(
    telaNavAtual === "ferramentas" && ferramentasSubAtual === "importacao-consulta" && estado.autenticado && !estado.idcentralAutenticado,
    tela === "ferramentas" && novoSub === "importacao-consulta",
    "/api/logout-avulso"
  );

  // Consultas de Ferramentas escrevem no mesmo #saida do Kanban/Lista (setSaida
  // é compartilhado) — ao ENTRAR de novo na sub-tela de Importação/Consulta,
  // limpa o que sobrou de uma consulta/tela anterior em vez de mostrar lixo.
  const entrandoNaImportacaoConsulta = tela === "ferramentas" && novoSub === "importacao-consulta"
    && !(telaNavAtual === "ferramentas" && ferramentasSubAtual === "importacao-consulta");

  if (tela === "ficha") fichaOrigem = opcoes.origem || fichaOrigem || "dashboard";

  telaNavAtual = tela;
  ferramentasSubAtual = novoSub;

  const telasUnicas = new Set(Object.values(TELAS_NAV));
  telasUnicas.forEach((elemento) => elemento && elemento.classList.add("hidden"));
  const alvo = TELAS_NAV[tela];
  if (alvo) alvo.classList.remove("hidden");
  // A sub-tela de Importação/Consulta precisa do painel de Saída visível
  // JUNTO (ele mostra o resultado das Consultas) — os dois ficam empilhados
  // porque .conteudo é flex-column.
  if (tela === "ferramentas" && novoSub === "importacao-consulta") {
    TELAS_NAV.implantacao.classList.remove("hidden");
  }
  if (tela === "ferramentas") mostrarFerramentasSub(novoSub);
  Object.entries(NAV_BOTOES).forEach(([nome, botao]) => {
    if (botao) botao.classList.toggle("ativo", nome === tela);
  });

  const naFicha = tela === "ficha";
  sidebarRaiz.classList.toggle("hidden", naFicha);
  sidebarCliente.classList.toggle("hidden", !naFicha);

  if (!opcoes.semHistorico) {
    const caminho = naFicha
      ? `/cliente/${encodeURIComponent(opcoes.idcentral)}`
      : (novoSub ? `/ferramentas/${novoSub}` : (CAMINHO_POR_TELA[tela] || "/"));
    if (window.location.pathname !== caminho) {
      history.pushState({ tela, idcentral: opcoes.idcentral, sub: novoSub, origem: naFicha ? fichaOrigem : undefined }, "", caminho);
    }
  }
  marcarTelaListaCompacta(tela === "implantacao" || tela === "migracao");
  atualizarTituloTopbar(tela, novoSub);
  atualizarSidebarVoltar();
  if (tela === "implantacao") { atualizarSaidaHeader("Controle de Implantação", false); carregarImplantacaoClientes(); }
  if (tela === "migracao") { atualizarSaidaHeader("Controle de Migração", false); carregarClientesMigracao(); }
  if (tela === "dashboard") carregarDashboardNovo();
  if (tela === "feed") carregarFeed();
  if (tela === "ficha") carregarFichaCliente(opcoes.idcentral);
  if (tela === "minha-conta") { carregarMinhaConta(); carregarMinhasTarefas(); }
  if (entrandoNaImportacaoConsulta) { atualizarSaidaHeader("Saída", true); mostrarPlaceholder("Autentique-se e escolha uma consulta ou importação."); }
}

function irParaFicha(idcentral) {
  if (!idcentral) return;
  const origem = ["implantacao", "migracao", "minha-conta"].includes(telaNavAtual) ? telaNavAtual : "dashboard";
  irParaTela("ficha", { idcentral, origem });
}

// --- FEED (publicações da equipe, estilo comunidade) ---
// Tudo é montado com createElement/textContent (nunca innerHTML com texto de
// usuário). Sem atualização automática: cada leitura do feed custa leituras no
// Firestore, então a lista só é recarregada ao abrir a tela ou no botão
// "Atualizar".
// Espelham FEED_TEXTO_MAX e FEED_PAGINA do app.py.
const FEED_TEXTO_MAX_CLIENTE = 2000;
const FEED_PAGINA_CLIENTE = 20;
const feedComposer = el("feed-composer");
const feedTexto = el("feed-texto");
const feedCliente = el("feed-cliente");
const feedPublicar = el("feed-publicar");
const feedErro = el("feed-erro");
const feedLista = el("feed-lista");
const feedMais = el("feed-mais");
let feedCursor = null;
let feedCarregando = false;
const feedComentariosAbertos = new Set();

function feedMostrarErro(msg) {
  feedErro.textContent = msg || "";
  feedErro.classList.toggle("hidden", !msg);
}

async function feedRequisicao(url, opcoes) {
  const r = await fetch(url, opcoes);
  const data = await parseJsonResponse(r);
  if (!data.ok) throw new Error(data.error || "Erro ao comunicar com o servidor.");
  return data;
}

function feedJsonHeaders() {
  return { "Content-Type": "application/json" };
}

function feedFormatarData(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function feedIniciais(nome) {
  const partes = String(nome || "?").trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return "?";
  return (partes[0][0] + (partes.length > 1 ? partes[partes.length - 1][0] : "")).toUpperCase();
}

function feedPostsNaTela() {
  return feedLista.querySelectorAll(".feed-post").length;
}

function feedMostrarVazio() {
  if (feedLista.querySelector(".feed-post")) return;
  const vazio = document.createElement("p");
  vazio.className = "feed-vazio placeholder";
  vazio.textContent = "Nenhuma publicação ainda. Seja o primeiro a escrever.";
  feedLista.appendChild(vazio);
}

function feedCriarCard(post) {
  const card = document.createElement("article");
  card.className = "feed-post";
  card.dataset.id = post.id;

  const ehSasha = post.tipo === "aniversario";
  if (ehSasha) card.classList.add("feed-post-aniversario");

  const cabecalho = document.createElement("header");
  cabecalho.className = "feed-post-cabecalho";
  const avatar = document.createElement("div");
  avatar.className = ehSasha ? "feed-avatar feed-avatar-robo" : "feed-avatar";
  avatar.textContent = ehSasha ? "🤖" : feedIniciais(post.autor_nome);
  const meta = document.createElement("div");
  meta.className = "feed-post-meta";
  const autor = document.createElement("strong");
  autor.textContent = post.autor_nome || "Usuário";
  const detalhe = document.createElement("span");
  detalhe.textContent = [feedFormatarData(post.criado_em), post.cliente_nome ? `· ${post.cliente_nome}` : "· Geral"].join(" ");
  meta.append(autor, detalhe);
  cabecalho.append(avatar, meta);
  if (post.pode_excluir) {
    const excluir = document.createElement("button");
    excluir.type = "button";
    excluir.className = "feed-acao-excluir";
    excluir.title = "Excluir publicação";
    excluir.textContent = "×";
    excluir.addEventListener("click", () => feedExcluirPost(post.id, card));
    cabecalho.appendChild(excluir);
  }

  const texto = document.createElement("p");
  texto.className = "feed-post-texto";
  texto.textContent = post.texto;

  const acoes = document.createElement("footer");
  acoes.className = "feed-post-acoes";
  const btnCurtir = document.createElement("button");
  btnCurtir.type = "button";
  btnCurtir.className = "feed-acao";
  const btnComentar = document.createElement("button");
  btnComentar.type = "button";
  btnComentar.className = "feed-acao";
  acoes.append(btnCurtir, btnComentar);

  const areaComentarios = document.createElement("div");
  areaComentarios.className = "feed-comentarios hidden";

  function pintarAcoes() {
    btnCurtir.classList.toggle("ativo", !!post.curtido_por_mim);
    btnCurtir.textContent = `♥ ${post.curtidas_total}`;
    btnComentar.textContent = `💬 ${post.comentarios_total}`;
  }
  pintarAcoes();

  btnCurtir.addEventListener("click", async () => {
    try {
      const data = await feedRequisicao(`/api/feed/${encodeURIComponent(post.id)}/curtir`, { method: "POST" });
      post.curtido_por_mim = data.curtido_por_mim;
      post.curtidas_total = data.curtidas_total;
      pintarAcoes();
    } catch (e) {
      feedMostrarErro(e.message);
    }
  });
  btnComentar.addEventListener("click", () => feedAlternarComentarios(post, areaComentarios, pintarAcoes));

  card.append(cabecalho, texto, acoes, areaComentarios);
  if (feedComentariosAbertos.has(post.id)) feedAbrirComentarios(post, areaComentarios, pintarAcoes);
  return card;
}

async function feedExcluirPost(postId, card) {
  if (!confirm("Excluir esta publicação e todos os comentários dela?")) return;
  try {
    await feedRequisicao(`/api/feed/${encodeURIComponent(postId)}`, { method: "DELETE" });
    feedComentariosAbertos.delete(postId);
    card.remove();
    feedMostrarVazio();
  } catch (e) {
    feedMostrarErro(e.message);
  }
}

function feedAlternarComentarios(post, area, pintarAcoes) {
  if (area.classList.contains("hidden")) {
    feedAbrirComentarios(post, area, pintarAcoes);
  } else {
    area.classList.add("hidden");
    feedComentariosAbertos.delete(post.id);
  }
}

function feedAbrirComentarios(post, area, pintarAcoes) {
  feedComentariosAbertos.add(post.id);
  area.classList.remove("hidden");
  if (!area.dataset.montado) {
    area.dataset.montado = "1";
    const lista = document.createElement("div");
    lista.className = "feed-comentarios-lista";
    const form = document.createElement("form");
    form.className = "feed-comentario-form";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = FEED_TEXTO_MAX_CLIENTE;
    input.placeholder = "Escreva um comentário…";
    input.className = "feed-comentario-input";
    const enviar = document.createElement("button");
    enviar.type = "submit";
    enviar.className = "btn-primary feed-comentario-enviar";
    enviar.textContent = "Enviar";
    form.append(input, enviar);
    area.append(lista, form);

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const texto = input.value.trim();
      if (!texto) return;
      enviar.disabled = true;
      try {
        await feedRequisicao(`/api/feed/${encodeURIComponent(post.id)}/comentarios`, {
          method: "POST", headers: feedJsonHeaders(), body: JSON.stringify({ texto }),
        });
        input.value = "";
        post.comentarios_total += 1;
        pintarAcoes();
        await feedCarregarComentarios(post, area, pintarAcoes);
      } catch (e) {
        feedMostrarErro(e.message);
      } finally {
        enviar.disabled = false;
      }
    });
  }
  feedCarregarComentarios(post, area, pintarAcoes);
}

async function feedCarregarComentarios(post, area, pintarAcoes) {
  const lista = area.querySelector(".feed-comentarios-lista");
  try {
    const data = await feedRequisicao(`/api/feed/${encodeURIComponent(post.id)}/comentarios`);
    lista.innerHTML = "";
    if (!data.comentarios.length) {
      const vazio = document.createElement("p");
      vazio.className = "feed-comentarios-vazio";
      vazio.textContent = "Sem comentários ainda.";
      lista.appendChild(vazio);
    }
    data.comentarios.forEach((c) => {
      const linha = document.createElement("div");
      linha.className = "feed-comentario";
      const autor = document.createElement("strong");
      autor.textContent = c.autor_nome || "Usuário";
      const texto = document.createElement("span");
      texto.className = "feed-comentario-texto";
      texto.textContent = c.texto;
      const quando = document.createElement("small");
      quando.textContent = feedFormatarData(c.criado_em);
      linha.append(autor, texto, quando);
      if (c.pode_excluir) {
        const excluir = document.createElement("button");
        excluir.type = "button";
        excluir.className = "feed-acao-excluir";
        excluir.title = "Excluir comentário";
        excluir.textContent = "×";
        excluir.addEventListener("click", async () => {
          if (!confirm("Excluir este comentário?")) return;
          try {
            await feedRequisicao(`/api/feed/comentarios/${encodeURIComponent(c.id)}`, { method: "DELETE" });
            post.comentarios_total = Math.max(0, post.comentarios_total - 1);
            pintarAcoes();
            feedCarregarComentarios(post, area, pintarAcoes);
          } catch (e) {
            feedMostrarErro(e.message);
          }
        });
        linha.appendChild(excluir);
      }
      lista.appendChild(linha);
    });
  } catch (e) {
    feedMostrarErro(e.message);
  }
}

// `reiniciar` refaz a lista do começo com a mesma quantidade já exibida, pra
// atualização automática não jogar fora as páginas que a pessoa já carregou.
async function feedCarregar({ reiniciar = false } = {}) {
  if (feedCarregando) return;
  feedCarregando = true;
  feedMais.disabled = true;
  const params = new URLSearchParams();
  if (reiniciar) {
    params.set("limite", String(Math.max(FEED_PAGINA_CLIENTE, feedPostsNaTela())));
  } else if (feedCursor) {
    params.set("antes_de", feedCursor);
  }
  try {
    const data = await feedRequisicao(`/api/feed?${params.toString()}`);
    if (reiniciar) feedLista.innerHTML = "";
    const vazioAntes = feedLista.querySelector(".feed-vazio");
    if (vazioAntes) vazioAntes.remove();
    data.posts.forEach((post) => feedLista.appendChild(feedCriarCard(post)));
    if (data.posts.length) feedCursor = data.posts[data.posts.length - 1].criado_em;
    feedMais.classList.toggle("hidden", data.posts.length < Number(params.get("limite") || FEED_PAGINA_CLIENTE));
    feedMostrarVazio();
    feedMostrarErro("");
  } catch (e) {
    feedMostrarErro(e.message);
  } finally {
    feedCarregando = false;
    feedMais.disabled = false;
  }
}

async function feedCarregarClientes() {
  try {
    const r = await fetch("/api/clientes");
    const data = await parseJsonResponse(r);
    const atual = feedCliente.value;
    feedCliente.innerHTML = "";
    const geral = document.createElement("option");
    geral.value = "";
    geral.textContent = "Geral (sem cliente)";
    feedCliente.appendChild(geral);
    (data.clientes || [])
      .slice()
      .sort((a, b) => String(a.cliente || "").localeCompare(String(b.cliente || ""), "pt-BR"))
      .forEach((c) => {
        const opcao = document.createElement("option");
        opcao.value = c.id;
        opcao.textContent = c.cliente || c.id;
        feedCliente.appendChild(opcao);
      });
    feedCliente.value = atual;
  } catch (e) {
    feedMostrarErro("Não foi possível carregar a lista de clientes.");
  }
}

async function carregarFeed() {
  const podePublicar = document.body.dataset.usuarioPerfil !== "visualizacao";
  feedComposer.classList.toggle("hidden", !podePublicar);
  feedCarregarClientes();
  feedCursor = null;
  await feedCarregar({ reiniciar: true });
}

feedComposer.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const texto = feedTexto.value.trim();
  if (!texto) {
    feedMostrarErro("Escreva algo antes de publicar.");
    return;
  }
  feedPublicar.disabled = true;
  try {
    const data = await feedRequisicao("/api/feed", {
      method: "POST", headers: feedJsonHeaders(),
      body: JSON.stringify({ texto, cliente_id: feedCliente.value }),
    });
    feedTexto.value = "";
    feedMostrarErro("");
    const vazio = feedLista.querySelector(".feed-vazio");
    if (vazio) vazio.remove();
    feedLista.prepend(feedCriarCard(data.post));
  } catch (e) {
    feedMostrarErro(e.message);
  } finally {
    feedPublicar.disabled = false;
  }
});
feedMais.addEventListener("click", () => feedCarregar());
el("feed-atualizar").addEventListener("click", () => {
  feedCursor = null;
  feedCarregar({ reiniciar: true });
});

NAV_BOTOES.feed.addEventListener("click", () => irParaTela("feed"));

// Na Ficha, o logo é a saída (não há mais botão "Voltar") — então também
// protege o checklist de marcos não salvo.
el("sidebar-logo").addEventListener("click", () => {
  if (telaNavAtual === "ficha" && !podeSairDaAbaMarcos()) return;
  irParaTela("dashboard");
});
NAV_BOTOES.dashboard.addEventListener("click", () => irParaTela("dashboard"));
NAV_BOTOES.implantacao.addEventListener("click", () => irParaTela("implantacao"));
NAV_BOTOES.migracao.addEventListener("click", () => irParaTela("migracao"));
NAV_BOTOES.ferramentas.addEventListener("click", () => irParaTela("ferramentas"));

el("card-ferramentas-importacao").addEventListener("click", () => irParaTela("ferramentas", { sub: "importacao-consulta" }));
// Perfil "visualizacao" não tem esse card no HTML (só lê, nenhuma ação).
if (el("card-ferramentas-comandos")) {
  el("card-ferramentas-comandos").addEventListener("click", () => irParaTela("ferramentas", { sub: "comandos" }));
}
if (el("card-ferramentas-sync-planilha")) {
  el("card-ferramentas-sync-planilha").addEventListener("click", () => irParaTela("ferramentas", { sub: "sync-planilha" }));
}
el("card-ferramentas-quebra-string").addEventListener("click", () => irParaTela("ferramentas", { sub: "quebra-string" }));
el("card-ferramentas-central-importacao").addEventListener("click", () => irParaTela("ferramentas", { sub: "central-importacao" }));
// Pelo card o formulário do conversor começa limpo; Voltar/Avançar do navegador mantém o que estava.
// Os dois cards de Áreas (Planilha e KML) agora vivem dentro da Central de
// Importação, não mais soltos no grid raiz de Ferramentas Auxiliares — ver
// SUBTELAS_FILHAS_DA_CENTRAL_IMPORTACAO.
el("card-central-areas-kml").addEventListener("click", () => {
  limparConversor();
  irParaTela("ferramentas", { sub: "conversor-kml" });
});
el("card-central-areas-planilha").addEventListener("click", () => {
  limparConvare();
  irParaTela("ferramentas", { sub: "conversor-areas" });
});
el("card-central-clientes").addEventListener("click", () => {
  limparConvcli();
  irParaTela("ferramentas", { sub: "conversor-clientes" });
});
el("card-central-veiculos").addEventListener("click", () => {
  limparConvvei();
  irParaTela("ferramentas", { sub: "conversor-veiculos" });
});
el("card-central-rastreadores").addEventListener("click", () => {
  limparConvrst();
  irParaTela("ferramentas", { sub: "conversor-rastreadores" });
});
el("card-central-simcards").addEventListener("click", () => {
  limparConvsim();
  irParaTela("ferramentas", { sub: "conversor-simcards" });
});
el("card-central-uo").addEventListener("click", () => {
  limparConvuo();
  irParaTela("ferramentas", { sub: "conversor-uo" });
});
el("card-central-colaboradores").addEventListener("click", () => {
  limparConvcol();
  irParaTela("ferramentas", { sub: "conversor-colaboradores" });
});
el("card-central-viagens").addEventListener("click", () => {
  irParaTela("ferramentas", { sub: "conversor-viagens" });
});
el("card-central-abastecimento").addEventListener("click", () => {
  irParaTela("ferramentas", { sub: "conversor-abastecimento" });
});
el("card-central-atalhos").addEventListener("click", () => {
  limparAtalhos();
  irParaTela("ferramentas", { sub: "atalhos" });
});
// "Voltar" discreto do sidebar: só aparece em telas "filhas" — sub-tela de
// Ferramentas → Ferramentas; Ficha → de onde foi aberta; Minha conta (aberta pelo
// menu do usuário) → Dashboard. Nas telas iniciais do sidebar (Dashboard, Feed,
// Implantação, Migração, Ferramentas) o próprio menu já é a navegação, então some.
const sidebarVoltar = el("sidebar-voltar");

function destinoVoltar() {
  if (telaNavAtual === "ferramentas" && ferramentasSubAtual) {
    // Sub-tela aberta a partir da Central de Importação SSX (ex.: Conversor de
    // Clientes) volta pra Central, não direto pro grid de Ferramentas Auxiliares.
    if (SUBTELAS_FILHAS_DA_CENTRAL_IMPORTACAO.includes(ferramentasSubAtual)) {
      return { tela: "ferramentas", sub: "central-importacao" };
    }
    return { tela: "ferramentas" };
  }
  if (telaNavAtual === "ficha") return { tela: fichaOrigem || "dashboard" };
  if (telaNavAtual === "minha-conta") return { tela: "dashboard" };
  return null;
}

function atualizarSidebarVoltar() {
  const destino = destinoVoltar();
  sidebarVoltar.classList.toggle("hidden", !destino);
  if (destino) {
    const titulo = (destino.tela === "ferramentas" && TITULO_TOPBAR_POR_SUB[destino.sub]) || TITULO_TOPBAR_POR_TELA[destino.tela] || "Dashboard";
    sidebarVoltar.title = `Voltar para ${titulo}`;
  }
}

sidebarVoltar.addEventListener("click", () => {
  const destino = destinoVoltar();
  if (!destino) return;
  if (telaNavAtual === "ficha" && !podeSairDaAbaMarcos()) return;
  irParaTela(destino.tela, { sub: destino.sub });
});

// --- SINCRONIZAR PLANILHA (planilha de CS -> cadastro de cliente do app) ---
// Fluxo em 2 passos, mesmo racional do preview/confirmar da Importação de
// Clientes: 1) busca a planilha e mostra o que mudaria (nada é gravado ainda,
// sync_id fica guardado no backend); 2) só grava de fato quando confirma no
// botão "Aplicar sincronização".
let syncPlanilhaIdAtual = null;

function formatarValorMudanca(campo, valor) {
  if (campo === "valor_contrato") return formatarMoedaBRL(valor);
  const texto = String(valor ?? "").trim();
  return texto || "(vazio)";
}

function renderSyncPlanilhaResultado(data) {
  const container = el("sync-planilha-resultado");
  container.innerHTML = "";

  const resumo = document.createElement("p");
  resumo.className = "placeholder";
  resumo.textContent = `${data.total_linhas} linhas na planilha — `
    + `${data.resumo.criar} cliente${data.resumo.criar === 1 ? "" : "s"} novo${data.resumo.criar === 1 ? "" : "s"}, `
    + `${data.resumo.atualizar} pra atualizar, `
    + `${data.resumo.sem_idcentral} sem Id central (ignorado${data.resumo.sem_idcentral === 1 ? "" : "s"}).`;
  container.appendChild(resumo);

  if (data.sem_idcentral && data.sem_idcentral.length) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = `Sem Id central na planilha: ${data.sem_idcentral.join(", ")}`;
    container.appendChild(p);
  }

  if (!data.itens.length) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nada pra sincronizar — o app já está igual à planilha.";
    container.appendChild(p);
    return;
  }

  const table = document.createElement("table");
  table.className = "tabela-saida";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Cliente</th><th>Ação</th><th>Campo</th><th>De</th><th>Para</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");

  data.itens.forEach((item) => {
    item.mudancas.forEach((m, idx) => {
      const tr = document.createElement("tr");
      const tdCliente = document.createElement("td");
      tdCliente.textContent = idx === 0 ? (item.cliente || item.idcentral) : "";
      const tdAcao = document.createElement("td");
      tdAcao.textContent = idx === 0 ? (item.acao === "criar" ? "Criar cliente" : "Atualizar") : "";
      const tdCampo = document.createElement("td");
      tdCampo.textContent = m.rotulo;
      const tdDe = document.createElement("td");
      tdDe.textContent = formatarValorMudanca(m.campo, m.de);
      const tdPara = document.createElement("td");
      tdPara.textContent = formatarValorMudanca(m.campo, m.para);
      tr.appendChild(tdCliente);
      tr.appendChild(tdAcao);
      tr.appendChild(tdCampo);
      tr.appendChild(tdDe);
      tr.appendChild(tdPara);
      tbody.appendChild(tr);
    });
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

el("btn-buscar-sync-planilha").addEventListener("click", async () => {
  const status = el("sync-planilha-status");
  const btnAplicar = el("btn-aplicar-sync-planilha");
  btnAplicar.classList.add("hidden");
  syncPlanilhaIdAtual = null;
  status.textContent = "Buscando planilha...";
  el("sync-planilha-resultado").innerHTML = "";
  try {
    const r = await fetch("/api/clientes/sync-planilha/preview");
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      status.textContent = `Erro: ${data.error || "falha desconhecida"}`;
      return;
    }
    status.textContent = "";
    syncPlanilhaIdAtual = data.sync_id;
    renderSyncPlanilhaResultado(data);
    if (data.itens.length) btnAplicar.classList.remove("hidden");
  } catch (err) {
    status.textContent = `Erro: ${String(err)}`;
  }
});

el("btn-aplicar-sync-planilha").addEventListener("click", async () => {
  if (!syncPlanilhaIdAtual) return;
  const status = el("sync-planilha-status");
  const btnAplicar = el("btn-aplicar-sync-planilha");
  btnAplicar.disabled = true;
  status.textContent = "Aplicando...";
  try {
    const r = await fetch("/api/clientes/sync-planilha/aplicar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sync_id: syncPlanilhaIdAtual }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      status.textContent = `Erro: ${data.error || "falha desconhecida"}`;
      btnAplicar.disabled = false;
      return;
    }
    let texto = `Aplicado: ${data.criados} criado${data.criados === 1 ? "" : "s"}, `
      + `${data.atualizados} atualizado${data.atualizados === 1 ? "" : "s"}.`;
    if (data.ignorados && data.ignorados.length) {
      texto += ` ${data.ignorados.length} ignorado${data.ignorados.length === 1 ? "" : "s"} (mudou nesse meio tempo).`;
    }
    status.textContent = texto;
    btnAplicar.classList.add("hidden");
    syncPlanilhaIdAtual = null;
    el("sync-planilha-resultado").innerHTML = "";
  } catch (err) {
    status.textContent = `Erro: ${String(err)}`;
    btnAplicar.disabled = false;
  }
});

// Voltar/Avançar do navegador: não empurra uma URL nova, só reflete a que já
// está na barra de endereço (ou o estado salvo no pushState, se houver).
window.addEventListener("popstate", (e) => {
  if (e.state && e.state.tela) {
    irParaTela(e.state.tela, { semHistorico: true, idcentral: e.state.idcentral, sub: e.state.sub, origem: e.state.origem });
    return;
  }
  const resolvido = resolverCaminho(window.location.pathname);
  irParaTela(resolvido.tela, { semHistorico: true, idcentral: resolvido.idcentral, sub: resolvido.sub });
});

// Sair da aba Marcos com checklist alterado e não salvo pede confirmação.
function podeSairDaAbaMarcos() {
  return fichaAbaAtual !== "marcos" || confirmarDescartarMarcos();
}
["geral", "implantacao", "marcos", "migracao", "historico"].forEach((aba) => {
  el(`ficha-aba-${aba}`).addEventListener("click", () => {
    // Clicar de novo em "Marcos" re-renderizaria a aba e perderia o rascunho.
    if (aba === fichaAbaAtual && aba === "marcos") return;
    if (aba !== fichaAbaAtual && !podeSairDaAbaMarcos()) return;
    mostrarFichaAba(aba);
  });
});

el("card-ir-implantacao").addEventListener("click", () => irParaTela("implantacao"));
el("card-ir-migracao").addEventListener("click", () => irParaTela("migracao"));
el("card-ir-ferramentas").addEventListener("click", () => irParaTela("ferramentas"));

async function carregarDashboardNovo() {
  try {
    const r = await fetch("/api/dashboard");
    const data = await parseJsonResponse(r);
    if (!data.ok) return;
    el("tile-implantacao-ativos").textContent = data.implantacao_ativos ?? "–";
    el("tile-migracao-ativos").textContent = data.migracao_ativos ?? "–";
    el("tile-veiculos-migrados").textContent = (data.por_status && data.por_status.Migrado) ?? "–";

    const rClientes = await fetch("/api/clientes");
    const dataClientes = await parseJsonResponse(rClientes);
    const clientes = dataClientes.ok ? (dataClientes.clientes || []) : [];
    // Reaproveita na busca global da topbar (sem ler de novo).
    if (dataClientes.ok) buscaGlobalClientes = clientes;

    const insights = el("dashboard-insights");
    insights.innerHTML = "";
    insights.appendChild(renderDashboardAtrasados(clientes));
    insights.appendChild(renderDashboardParados(clientes));
    insights.appendChild(renderDashboardTempoMarcos(clientes));
    insights.appendChild(renderDashboardFunil(clientes));
    insights.appendChild(renderDashboardFlags(clientes));
    insights.appendChild(renderDashboardVeiculosStatus(data));
  } catch (err) {
    // Silencioso — os tiles ficam com "–" e o resto do app continua normal.
  }
}

// Mesma regra de atraso usada no card do Kanban e na tag da Ficha (ver
// marcoAtrasado) — só que aqui varrendo a carteira toda, pra alimentar o
// tile e a lista de atenção do Dashboard.
function clientesComMarcoAtrasado(clientes) {
  return clientes
    .filter((c) => c.etapa !== "concluido" && marcoAtrasado(c.data_entrada, c.etapa, c.marcos_concluidos))
    .map((c) => ({ ...c, diasAtraso: (diasDesdeEntrada(c.data_entrada) || 0) - IMPLANTACAO_MARCO_PRAZOS[c.etapa] }))
    .sort((a, b) => b.diasAtraso - a.diasAtraso);
}

// "Implantações paradas": sem atividade há mais de DIAS_IMPLANTACAO_PARADA dias.
function renderDashboardParados(clientes) {
  const parados = clientes
    .filter(clienteParado)
    .map((c) => ({ c, dias: diasSemAtividade(c) }))
    .sort((a, b) => b.dias - a.dias);
  const card = document.createElement("div");
  card.className = "insight-card";
  const h = document.createElement("h3");
  h.textContent = `Implantações paradas (sem atividade há mais de ${DIAS_IMPLANTACAO_PARADA} dias)`;
  card.appendChild(h);
  if (!parados.length) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nenhuma implantação parada no momento.";
    card.appendChild(p);
    return card;
  }
  const LIMITE_VISIVEL = 6;
  const lista = document.createElement("div");
  lista.className = "lista-atrasados";
  parados.slice(0, LIMITE_VISIVEL).forEach(({ c, dias }) => {
    const item = document.createElement("div");
    item.className = "lista-atrasados-item";
    item.addEventListener("click", () => abrirClienteOuFicha(c, abrirTimelineImplantacao));
    const nome = document.createElement("span");
    nome.className = "lista-atrasados-nome";
    nome.textContent = c.cliente || c.idcentral || "(sem nome)";
    const etapaSpan = document.createElement("span");
    etapaSpan.className = "lista-atrasados-etapa";
    etapaSpan.textContent = `${nomeCurtoEtapaImplantacao(c.etapa)}${c.csm ? ` · ${c.csm}` : ""}`;
    nome.appendChild(etapaSpan);
    const diasSpan = document.createElement("span");
    diasSpan.className = "lista-atrasados-dias lista-parados-dias";
    diasSpan.textContent = `${dias} dias sem atividade`;
    item.appendChild(nome);
    item.appendChild(diasSpan);
    lista.appendChild(item);
  });
  card.appendChild(lista);
  if (parados.length > LIMITE_VISIVEL) {
    const resto = parados.length - LIMITE_VISIVEL;
    const mais = document.createElement("div");
    mais.className = "lista-atrasados-mais";
    mais.textContent = resto === 1 ? "+ 1 outra implantação parada" : `+ ${resto} outras implantações paradas`;
    card.appendChild(mais);
  }
  return card;
}

// "Tempo nos marcos": TTV (entrada → Marco 2 / Quick Win) e tempo médio de
// cada marco (do fim do marco anterior — ou da entrada, no Marco 1 — até a
// conclusão). Só entra quem tem as datas (gravadas a partir de 29/09/2026).
function renderDashboardTempoMarcos(clientes) {
  const card = document.createElement("div");
  card.className = "insight-card";
  const h = document.createElement("h3");
  h.textContent = "Tempo nos marcos";
  card.appendChild(h);

  const media = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  const plural = (n, s) => `${n} ${s}${n === 1 ? "" : "s"}`;
  const ttv = [];
  const porMarco = {};
  IMPLANTACAO_MARCOS.forEach((m) => { porMarco[m] = []; });
  clientes.forEach((c) => {
    const datas = c.marcos_concluidos_em || {};
    if (datas["marco-2"]) {
      const d = diasEntre(c.data_entrada, datas["marco-2"]);
      if (d !== null && d >= 0) ttv.push(d);
    }
    IMPLANTACAO_MARCOS.forEach((m, i) => {
      if (!datas[m]) return;
      const inicio = i === 0 ? c.data_entrada : datas[IMPLANTACAO_MARCOS[i - 1]];
      const d = inicio ? diasEntre(inicio, datas[m]) : null;
      if (d !== null && d >= 0) porMarco[m].push(d);
    });
  });

  const grid = document.createElement("div");
  grid.className = "tempo-marcos-grid";
  const bloco = (rotulo, valor, detalhe, destaque) => {
    const b = document.createElement("div");
    b.className = `tempo-marcos-bloco${destaque ? " destaque" : ""}`;
    const r = document.createElement("div");
    r.className = "tempo-marcos-rotulo";
    r.textContent = rotulo;
    const v = document.createElement("div");
    v.className = "tempo-marcos-valor";
    v.textContent = valor === null ? "–" : plural(valor, "dia");
    const d = document.createElement("div");
    d.className = "tempo-marcos-detalhe";
    d.textContent = detalhe;
    b.appendChild(r);
    b.appendChild(v);
    b.appendChild(d);
    grid.appendChild(b);
  };
  bloco("TTV médio (até a Quick Win)", media(ttv), plural(ttv.length, "cliente"), true);
  IMPLANTACAO_MARCOS.forEach((m, i) => {
    // Meta = janela do marco no Plano (Marco 3: dias 22 a 60 = 39 dias).
    const meta = IMPLANTACAO_MARCO_PRAZOS[m] - (i === 0 ? 0 : IMPLANTACAO_MARCO_PRAZOS[IMPLANTACAO_MARCOS[i - 1]]);
    bloco(nomeCurtoEtapaImplantacao(m), media(porMarco[m]), `meta ${meta} dias · ${plural(porMarco[m].length, "cliente")}`);
  });
  card.appendChild(grid);

  if (!ttv.length && IMPLANTACAO_MARCOS.every((m) => !porMarco[m].length)) {
    const p = document.createElement("p");
    p.className = "placeholder tempo-marcos-aviso";
    p.textContent = "As datas de conclusão dos marcos começaram a ser registradas agora — os números aparecem conforme os clientes forem concluindo marcos.";
    card.appendChild(p);
  }
  return card;
}

function renderDashboardAtrasados(clientes) {
  const atrasados = clientesComMarcoAtrasado(clientes);

  const tileValor = el("tile-clientes-atrasados");
  tileValor.textContent = atrasados.length;
  tileValor.classList.toggle("stat-tile-valor-alerta", atrasados.length > 0);

  const card = document.createElement("div");
  card.className = "insight-card";
  const h = document.createElement("h3");
  h.textContent = "Clientes com marco em atraso";
  card.appendChild(h);

  if (atrasados.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nenhum cliente com marco atrasado no momento.";
    card.appendChild(p);
    return card;
  }

  // Resumo dos motivos (árvore de decisão do Playbook) — mostra o padrão da
  // carteira: onde os clientes estão travando.
  const porMotivo = {};
  atrasados.forEach((c) => {
    const m = motivoAtrasoAtual(c);
    const chave = m ? MOTIVOS_ATRASO[m.motivo].rotulo : "Sem motivo registrado";
    porMotivo[chave] = (porMotivo[chave] || 0) + 1;
  });
  const resumo = document.createElement("div");
  resumo.className = "motivos-resumo";
  Object.entries(porMotivo).sort((a, b) => b[1] - a[1]).forEach(([rotulo, qtd]) => {
    const chip = document.createElement("span");
    chip.className = `motivos-resumo-chip${rotulo === "Sem motivo registrado" ? " sem-motivo" : ""}`;
    chip.textContent = `${rotulo}: ${qtd}`;
    resumo.appendChild(chip);
  });
  card.appendChild(resumo);

  const LIMITE_VISIVEL = 6;
  const lista = document.createElement("div");
  lista.className = "lista-atrasados";
  atrasados.slice(0, LIMITE_VISIVEL).forEach((c) => {
    const item = document.createElement("div");
    item.className = "lista-atrasados-item";
    item.addEventListener("click", () => irParaFicha(c.idcentral));

    const nome = document.createElement("span");
    nome.className = "lista-atrasados-nome";
    nome.textContent = c.cliente || c.idcentral || "(sem nome)";
    const etapaSpan = document.createElement("span");
    etapaSpan.className = "lista-atrasados-etapa";
    etapaSpan.textContent = IMPLANTACAO_ETAPA_LABELS[c.etapa] || c.etapa;
    nome.appendChild(etapaSpan);
    const motivo = motivoAtrasoAtual(c);
    const motivoSpan = document.createElement("span");
    motivoSpan.className = `lista-atrasados-motivo${motivo ? "" : " sem-motivo"}`;
    motivoSpan.textContent = motivo ? MOTIVOS_ATRASO[motivo.motivo].rotulo : "sem motivo";
    nome.appendChild(motivoSpan);

    const dias = document.createElement("span");
    dias.className = "lista-atrasados-dias";
    dias.textContent = `${c.diasAtraso} dia${c.diasAtraso === 1 ? "" : "s"} de atraso`;

    item.appendChild(nome);
    item.appendChild(dias);
    lista.appendChild(item);
  });
  card.appendChild(lista);

  if (atrasados.length > LIMITE_VISIVEL) {
    const resto = atrasados.length - LIMITE_VISIVEL;
    const mais = document.createElement("div");
    mais.className = "lista-atrasados-mais";
    mais.textContent = `+ ${resto} outro${resto === 1 ? "" : "s"} cliente${resto === 1 ? "" : "s"} atrasado${resto === 1 ? "" : "s"}`;
    card.appendChild(mais);
  }
  return card;
}

function renderDashboardFunil(clientes) {
  const card = document.createElement("div");
  card.className = "insight-card";
  const h = document.createElement("h3");
  h.textContent = "Funil de Implantação";
  card.appendChild(h);

  const contagem = {};
  IMPLANTACAO_ETAPAS_ORDEM.forEach((e) => { contagem[e] = 0; });
  clientes.forEach((c) => {
    const etapa = IMPLANTACAO_ETAPAS_ORDEM.includes(c.etapa) ? c.etapa : "marco-1";
    contagem[etapa] += 1;
  });

  card.appendChild(construirBarraDistribuicao(IMPLANTACAO_ETAPAS_ORDEM, MARCO_COR, contagem, clientes.length, IMPLANTACAO_ETAPA_LABELS));
  return card;
}

function renderDashboardFlags(clientes) {
  const card = document.createElement("div");
  card.className = "insight-card";
  const h = document.createElement("h3");
  h.textContent = "Flags de atenção";
  card.appendChild(h);

  const contagem = { "Yellow Flag": 0, "Red Flag": 0, "Black Flag": 0 };
  clientes.forEach((c) => { if (c.flag && contagem[c.flag] !== undefined) contagem[c.flag] += 1; });
  const total = contagem["Yellow Flag"] + contagem["Red Flag"] + contagem["Black Flag"];

  if (total === 0) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nenhum cliente com flag no momento.";
    card.appendChild(p);
    return card;
  }

  const linha = document.createElement("div");
  linha.className = "flags-resumo";
  [
    { flag: "Black Flag", classe: "tag-flag-black" },
    { flag: "Red Flag", classe: "tag-flag-red" },
    { flag: "Yellow Flag", classe: "tag-flag-yellow" },
  ].forEach(({ flag, classe }) => {
    if (!contagem[flag]) return;
    const item = document.createElement("span");
    item.className = `flag-resumo-item ${classe}`;
    item.textContent = `${flag}: ${contagem[flag]}`;
    linha.appendChild(item);
  });
  card.appendChild(linha);
  return card;
}

function renderDashboardVeiculosStatus(dashboardData) {
  const card = document.createElement("div");
  card.className = "insight-card";
  const h = document.createElement("h3");
  h.textContent = "Veículos por status (Migração)";
  card.appendChild(h);

  const total = dashboardData.total_veiculos || 0;
  if (total === 0) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nenhum veículo cadastrado em migração ainda.";
    card.appendChild(p);
    return card;
  }
  card.appendChild(construirBarraDistribuicao(STATUS_ORDEM, STATUS_COR, dashboardData.por_status || {}, total));
  return card;
}

// --- TAREFAS (vinculadas a cliente, atribuídas a um app_usuario) ---
// Compartilhado entre Ficha > Visão Geral (mostrarResponsavel) e Minha Conta >
// Tarefas (mostrarCliente) — mesmo componente de lista, o que muda é só quais
// colunas de contexto aparecem em cada lugar.

// diasDesdeEntrada(data) já devolve hoje-data — negativo quando "data" é no
// futuro, o que é exatamente "quantos dias faltam" pro prazo, sem precisar de
// nenhuma conta de data nova.
// Tarefa encerrada antes de existir "resultado" conta como concluída.
function resultadoTarefa(t) {
  return t.resultado === "cancelada" ? "cancelada" : "concluida";
}

function statusTarefa(t) {
  if (t.concluida && resultadoTarefa(t) === "cancelada") return { texto: "Cancelada", classe: "cancelado" };
  if (t.concluida) return { texto: "Concluída", classe: "concluido" };
  const diff = diasDesdeEntrada(t.data_limite);
  if (diff === null) return { texto: "", classe: "" };
  if (diff > 0) return { texto: `Atrasada há ${diff} dia${diff === 1 ? "" : "s"}`, classe: "atrasado" };
  if (diff === 0) return { texto: "Vence hoje", classe: "atrasado" };
  return { texto: `Faltam ${-diff} dia${-diff === 1 ? "" : "s"}`, classe: "ok" };
}

function construirListaTarefas(tarefas, opcoes) {
  opcoes = opcoes || {};
  const wrap = document.createElement("div");
  if (!tarefas.length) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nenhuma tarefa.";
    wrap.appendChild(p);
    return wrap;
  }

  tarefas.forEach((t) => {
    const item = document.createElement("div");
    item.className = "tarefa-item" + (t.concluida ? " concluida" : "")
      + (t.concluida && resultadoTarefa(t) === "cancelada" ? " cancelada" : "");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!t.concluida;
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", async () => {
      // Marcar abre o modal de Concluída/Cancelada — se a pessoa desistir,
      // o checkbox volta ao estado anterior.
      const ok = await alternarConclusaoTarefa(t.id, checkbox.checked, opcoes.aoMudar);
      if (!ok) checkbox.checked = !checkbox.checked;
    });
    item.appendChild(checkbox);

    const corpo = document.createElement("div");
    corpo.className = "tarefa-item-corpo";
    const titulo = document.createElement("div");
    titulo.className = "tarefa-item-titulo";
    titulo.textContent = t.titulo;
    corpo.appendChild(titulo);

    const meta = document.createElement("div");
    meta.className = "tarefa-item-meta";
    if (opcoes.mostrarCliente && t.cliente_nome) {
      const clienteSpan = document.createElement("span");
      clienteSpan.className = "tarefa-item-cliente";
      clienteSpan.textContent = t.cliente_nome;
      clienteSpan.addEventListener("click", () => irParaFicha(t.idcentral));
      meta.appendChild(clienteSpan);
    }
    if (opcoes.mostrarResponsavel && t.responsavel_nome) {
      const respSpan = document.createElement("span");
      respSpan.textContent = t.responsavel_nome;
      meta.appendChild(respSpan);
    }
    const dataSpan = document.createElement("span");
    dataSpan.textContent = formatarDataBRSimples(t.data_limite) || t.data_limite;
    meta.appendChild(dataSpan);
    const st = statusTarefa(t);
    if (st.texto) {
      const statusSpan = document.createElement("span");
      statusSpan.className = `tarefa-status ${st.classe}`;
      statusSpan.textContent = st.texto;
      meta.appendChild(statusSpan);
    }
    corpo.appendChild(meta);
    item.appendChild(corpo);

    if (opcoes.compacta) {
      // Modo compacto (hub de Minha Conta): sem botões inline — Editar/Excluir
      // ficam dentro do modal de detalhes, aberto ao clicar na linha.
      item.classList.add("tarefa-item-compacta");
      if (opcoes.aoClicar) {
        item.addEventListener("click", () => opcoes.aoClicar(t));
      }
    } else {
      const acoes = document.createElement("div");
      acoes.className = "tarefa-item-acoes";
      const btnEditar = document.createElement("button");
      btnEditar.type = "button";
      btnEditar.className = "btn-secondary";
      btnEditar.textContent = "Editar";
      btnEditar.addEventListener("click", () => abrirModalTarefa({ tarefa: t, aoSalvar: opcoes.aoMudar }));
      acoes.appendChild(btnEditar);
      const btnExcluir = document.createElement("button");
      btnExcluir.type = "button";
      btnExcluir.className = "btn-secondary";
      btnExcluir.textContent = "Excluir";
      btnExcluir.addEventListener("click", () => excluirTarefa(t.id, opcoes.aoMudar));
      acoes.appendChild(btnExcluir);
      item.appendChild(acoes);
    }

    wrap.appendChild(item);
  });
  return wrap;
}

// --- Modal "Finalizar tarefa": Concluída ou Cancelada (+ descrição, obrigatória
// se cancelada). Devolve uma Promise com { resultado, descricao }, ou null se a
// pessoa fechou sem salvar. ---
const overlayTarefaFinalizar = el("overlay-tarefa-finalizar");
const formTarefaFinalizar = el("form-tarefa-finalizar");
const tarefaFinalizarDescricao = el("tarefa-finalizar-descricao");
const tarefaFinalizarErro = el("tarefa-finalizar-erro");
let tarefaFinalizarResolver = null;

function resultadoEscolhidoFinalizar() {
  return formTarefaFinalizar.querySelector('input[name="tarefa-resultado"]:checked').value;
}

function atualizarRotuloFinalizar() {
  el("tarefa-finalizar-descricao-label").textContent = resultadoEscolhidoFinalizar() === "cancelada"
    ? "Por que não pôde ser concluída? (obrigatório)"
    : "Descrição (opcional)";
}

function pedirResultadoTarefa() {
  formTarefaFinalizar.querySelector('input[value="concluida"]').checked = true;
  tarefaFinalizarDescricao.value = "";
  tarefaFinalizarErro.classList.add("hidden");
  atualizarRotuloFinalizar();
  overlayTarefaFinalizar.classList.remove("hidden");
  tarefaFinalizarDescricao.focus();
  return new Promise((resolve) => { tarefaFinalizarResolver = resolve; });
}

function fecharFinalizar(valor) {
  overlayTarefaFinalizar.classList.add("hidden");
  if (tarefaFinalizarResolver) tarefaFinalizarResolver(valor);
  tarefaFinalizarResolver = null;
}

formTarefaFinalizar.querySelectorAll('input[name="tarefa-resultado"]').forEach((r) => {
  r.addEventListener("change", atualizarRotuloFinalizar);
});
el("tarefa-finalizar-fechar").addEventListener("click", () => fecharFinalizar(null));
formTarefaFinalizar.addEventListener("submit", (e) => {
  e.preventDefault();
  const resultado = resultadoEscolhidoFinalizar();
  const descricao = tarefaFinalizarDescricao.value.trim();
  if (resultado === "cancelada" && !descricao) {
    tarefaFinalizarErro.textContent = "Descreva por que a tarefa não pôde ser concluída.";
    tarefaFinalizarErro.classList.remove("hidden");
    return;
  }
  fecharFinalizar({ resultado, descricao });
});

async function alternarConclusaoTarefa(id, concluida, aoMudar) {
  let corpo = null;
  if (concluida) {
    corpo = await pedirResultadoTarefa();
    if (!corpo) return false;
  }
  try {
    const r = await fetch(`/api/tarefas/${id}/${concluida ? "concluir" : "reabrir"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo || {}),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      alert(`Erro: ${data.error || "falha desconhecida"}`);
      return false;
    }
    if (aoMudar) aoMudar();
    return true;
  } catch (err) {
    alert(`Erro: ${String(err)}`);
    return false;
  }
}

async function excluirTarefa(id, aoMudar) {
  if (!confirm("Excluir esta tarefa?")) return false;
  try {
    const r = await fetch(`/api/tarefas/${id}`, { method: "DELETE" });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      alert(`Erro: ${data.error || "falha desconhecida"}`);
      return false;
    }
    if (aoMudar) aoMudar();
    return true;
  } catch (err) {
    alert(`Erro: ${String(err)}`);
    return false;
  }
}

// --- Modal de detalhes da tarefa (aberto ao clicar na linha, no hub de
// Minha Conta e no histórico de concluídas) — visualização rápida, com
// atalho pra Editar (abre o form) e pra concluir/reabrir/excluir. ---
const overlayTarefaDetalhes = el("overlay-tarefa-detalhes");
let tarefaDetalhesAtual = null;
let tarefaDetalhesAoMudar = null;

function abrirDetalhesTarefa(tarefa, aoMudar) {
  tarefaDetalhesAtual = tarefa;
  tarefaDetalhesAoMudar = aoMudar || null;

  el("tarefa-detalhes-titulo").textContent = tarefa.titulo;
  const descricao = el("tarefa-detalhes-descricao");
  descricao.textContent = tarefa.descricao || "Sem descrição.";
  el("tarefa-detalhes-cliente").textContent = tarefa.cliente_nome || "—";
  el("tarefa-detalhes-responsavel").textContent = tarefa.responsavel_nome || "—";
  el("tarefa-detalhes-criador").textContent = tarefa.criado_por_nome || "—";
  el("tarefa-detalhes-criada").textContent = formatarDataBRSimples(tarefa.criado_em) || tarefa.criado_em || "—";
  el("tarefa-detalhes-prazo").textContent = formatarDataBRSimples(tarefa.data_limite) || tarefa.data_limite || "—";
  const st = statusTarefa(tarefa);
  el("tarefa-detalhes-status").textContent = st.texto || (tarefa.concluida ? "Concluída" : "—");

  // Desfecho deixado por quem finalizou — é o que quem criou a tarefa quer ver.
  const boxResultado = el("tarefa-detalhes-resultado");
  boxResultado.classList.toggle("hidden", !tarefa.concluida);
  if (tarefa.concluida) {
    const cancelada = resultadoTarefa(tarefa) === "cancelada";
    boxResultado.classList.toggle("cancelada", cancelada);
    const quem = tarefa.finalizada_por_nome ? ` por ${tarefa.finalizada_por_nome}` : "";
    const quando = formatarDataBRSimples(tarefa.concluida_em);
    el("tarefa-detalhes-resultado-titulo").textContent =
      `${cancelada ? "Cancelada" : "Concluída"}${quem}${quando ? ` em ${quando}` : ""}`;
    el("tarefa-detalhes-resultado-texto").textContent = tarefa.resultado_descricao || "Sem descrição.";
  }

  const btnConcluir = el("tarefa-detalhes-concluir");
  btnConcluir.textContent = tarefa.concluida ? "Reabrir tarefa" : "Finalizar tarefa";

  overlayTarefaDetalhes.classList.remove("hidden");
}

el("tarefa-detalhes-fechar").addEventListener("click", () => overlayTarefaDetalhes.classList.add("hidden"));

el("tarefa-detalhes-concluir").addEventListener("click", async () => {
  if (!tarefaDetalhesAtual) return;
  const ok = await alternarConclusaoTarefa(tarefaDetalhesAtual.id, !tarefaDetalhesAtual.concluida, tarefaDetalhesAoMudar);
  if (ok) overlayTarefaDetalhes.classList.add("hidden");
});

el("tarefa-detalhes-editar").addEventListener("click", () => {
  if (!tarefaDetalhesAtual) return;
  overlayTarefaDetalhes.classList.add("hidden");
  abrirModalTarefa({ tarefa: tarefaDetalhesAtual, aoSalvar: tarefaDetalhesAoMudar });
});

el("tarefa-detalhes-excluir").addEventListener("click", async () => {
  if (!tarefaDetalhesAtual) return;
  const excluiu = await excluirTarefa(tarefaDetalhesAtual.id, tarefaDetalhesAoMudar);
  if (excluiu) overlayTarefaDetalhes.classList.add("hidden");
});

// --- Modal Nova/Editar Tarefa ---
const overlayTarefa = el("overlay-tarefa");
const tarefaModalTitulo = el("tarefa-modal-titulo");
const tarefaCampoCliente = el("tarefa-campo-cliente");
const tarefaClienteBusca = el("tarefa-cliente-busca");
const tarefaClientesDatalist = el("tarefa-clientes-datalist");
const tarefaResponsavelSelect = el("tarefa-responsavel");
const tarefaErro = el("tarefa-erro");

// clienteFixo != null => aberta de dentro da Ficha (campo Cliente escondido);
// null => aberta de Minha Conta (precisa escolher o cliente no campo de busca).
let tarefaClienteFixo = null;
let tarefaEditandoId = null;
let tarefaAoSalvar = null;
let tarefaClientesMapa = {};
let tarefaUsuariosCarregados = false;

async function garantirOpcoesResponsavel() {
  if (tarefaUsuariosCarregados) return;
  try {
    const r = await fetch("/api/app-usuarios/opcoes");
    const data = await parseJsonResponse(r);
    if (!data.ok) return;
    tarefaResponsavelSelect.innerHTML = "";
    (data.usuarios || []).forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = u.nome || "(sem nome)";
      tarefaResponsavelSelect.appendChild(opt);
    });
    tarefaUsuariosCarregados = true;
  } catch (err) {
    // Silencioso — select fica vazio, some da falta de opção ao tentar salvar.
  }
}

async function garantirClientesParaBusca() {
  if (Object.keys(tarefaClientesMapa).length) return;
  try {
    const r = await fetch("/api/clientes");
    const data = await parseJsonResponse(r);
    if (!data.ok) return;
    tarefaClientesDatalist.innerHTML = "";
    (data.clientes || []).forEach((c) => {
      if (!c.cliente) return;
      tarefaClientesMapa[c.cliente] = { id: c.id, idcentral: c.idcentral };
      const opt = document.createElement("option");
      opt.value = c.cliente;
      tarefaClientesDatalist.appendChild(opt);
    });
  } catch (err) {
    // Silencioso — campo de busca fica sem sugestões.
  }
}

async function abrirModalTarefa(opcoes) {
  opcoes = opcoes || {};
  const tarefa = opcoes.tarefa || null;
  tarefaEditandoId = tarefa ? tarefa.id : null;
  tarefaAoSalvar = opcoes.aoSalvar || null;
  tarefaErro.classList.add("hidden");
  tarefaErro.textContent = "";

  el("tarefa-titulo").value = tarefa ? tarefa.titulo : "";
  el("tarefa-descricao").value = tarefa ? (tarefa.descricao || "") : "";
  el("tarefa-data-limite").value = tarefa ? tarefa.data_limite : "";
  tarefaModalTitulo.textContent = tarefa ? "Editar tarefa" : "Nova tarefa";

  await garantirOpcoesResponsavel();
  tarefaResponsavelSelect.value = tarefa ? tarefa.responsavel_id : USUARIO_ID_ATUAL;

  const clienteId = opcoes.clienteId || (tarefa && tarefa.cliente_id);
  if (clienteId) {
    tarefaCampoCliente.classList.add("hidden");
    tarefaClienteFixo = { id: clienteId };
  } else {
    tarefaCampoCliente.classList.remove("hidden");
    tarefaClienteFixo = null;
    tarefaClienteBusca.value = tarefa ? (tarefa.cliente_nome || "") : "";
    await garantirClientesParaBusca();
  }

  overlayTarefa.classList.remove("hidden");
}

el("tarefa-modal-fechar").addEventListener("click", () => overlayTarefa.classList.add("hidden"));

el("form-tarefa").addEventListener("submit", async (e) => {
  e.preventDefault();
  tarefaErro.classList.add("hidden");

  // Cliente é opcional aqui (modo Minha Conta) — campo em branco = tarefa sem
  // cliente, só aparece em Minha Conta de quem for o responsável.
  let clienteId = "";
  if (tarefaClienteFixo) {
    clienteId = tarefaClienteFixo.id;
  } else {
    const nomeDigitado = tarefaClienteBusca.value.trim();
    if (nomeDigitado) {
      const achado = tarefaClientesMapa[nomeDigitado];
      if (!achado) {
        tarefaErro.textContent = "Cliente não encontrado — escolha um da lista ou deixe em branco.";
        tarefaErro.classList.remove("hidden");
        return;
      }
      clienteId = achado.id;
    }
  }

  const corpo = {
    cliente_id: clienteId,
    titulo: el("tarefa-titulo").value.trim(),
    descricao: el("tarefa-descricao").value.trim(),
    data_limite: el("tarefa-data-limite").value,
    responsavel_id: tarefaResponsavelSelect.value,
  };

  try {
    const url = tarefaEditandoId ? `/api/tarefas/${tarefaEditandoId}` : "/api/tarefas";
    const r = await fetch(url, {
      method: tarefaEditandoId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      tarefaErro.textContent = data.error || "Falha ao salvar.";
      tarefaErro.classList.remove("hidden");
      return;
    }
    overlayTarefa.classList.add("hidden");
    if (tarefaAoSalvar) tarefaAoSalvar();
  } catch (err) {
    tarefaErro.textContent = String(err);
    tarefaErro.classList.remove("hidden");
  }
});

// --- FICHA DO CLIENTE (Fase 3a) ---
// Junta o cliente de Implantação e o de Migração pelo IdCentral (endpoint
// /api/ficha/<idcentral>). As abas Implantação/Migração só mostram um resumo
// + um botão que abre o MESMO modal de sempre (abrirTimelineImplantacao /
// abrirVeiculosMigracao) — sem duplicar aquela lógica.
let fichaClienteAtual = null; // { idcentral, implantacao, migracao } cru da API
let fichaAbaAtual = "geral";

function construirFichaHeader(implantacao, migracao, comEngrenagem) {
  const header = document.createElement("div");
  header.className = "ficha-header";

  const info = document.createElement("div");
  // Nome + tag "Migração" na mesma linha. Sem migração, não mostra tag
  // nenhuma (implantação é o padrão, não precisa de rótulo).
  const linhaTitulo = document.createElement("div");
  linhaTitulo.className = "ficha-header-titulo";
  const titulo = document.createElement("h2");
  titulo.textContent = (implantacao && implantacao.cliente) || (migracao && migracao.nome) || "Cliente";
  linhaTitulo.appendChild(titulo);
  if (migracao) {
    const badge = document.createElement("span");
    badge.className = "badge-tipo com-migracao";
    badge.textContent = "Migração";
    linhaTitulo.appendChild(badge);
  }
  info.appendChild(linhaTitulo);
  header.appendChild(info);

  if (comEngrenagem) {
    header.appendChild(construirFichaEngrenagem(implantacao, migracao));
  }

  return header;
}

// Engrenagem de edição da Ficha — aparece em todas as abas (Visão Geral,
// Implantação, Marcos, Migração). Clica e já abre
// direto a janela de configuração (abrirConfigFicha) — se o cliente só tem
// Implantação ou só Migração, ela mesma decide qual modal mostrar.
function construirFichaEngrenagem(implantacao, migracao) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-engrenagem-pagina ficha-engrenagem";
  btn.title = "Editar dados do cliente";
  aplicarIconeEngrenagem(btn);
  btn.addEventListener("click", () => abrirConfigFicha(implantacao, migracao));
  return btn;
}

// Contexto ativo quando a janela de configuração foi aberta pela engrenagem
// da Ficha (cliente com os dois cadastros) — permite trocar de aba pela
// sidebar interna do modal sem duplicar os modais de Implantação/Migração.
let fichaConfigContexto = null;

function abrirConfigFicha(implantacao, migracao) {
  // Cliente é um cadastro só; migração e credenciais SSX são separadas, cada
  // uma seu painel, trocados pela mesma sidebar (Implantação/Migração/
  // Credenciais SSX) independente de qual entrada foi clicada. Cliente sem
  // Implantação (tem_implantacao false, nasceu pela tela de Migração) não
  // tem o que editar em Implantação — a sidebar some esse item (ver
  // ativarSidebarConfig) e a aba inicial cai em Migração ou Credenciais.
  if (!implantacao) return;
  fichaConfigContexto = { implantacao, migracao };
  const abaInicial = implantacao.tem_implantacao !== false ? "implantacao" : (migracao ? "migracao" : "credenciais");
  mostrarConfigFichaAba(abaInicial);
}

function mostrarConfigFichaAba(aba) {
  if (!fichaConfigContexto) return;
  const { implantacao, migracao } = fichaConfigContexto;
  overlayImplantacaoCliente.classList.add("hidden");
  overlayMigracao.classList.add("hidden");
  overlayFichaCredencial.classList.add("hidden");
  if (aba === "implantacao") {
    abrirModalImplantacaoCliente(implantacao);
    ativarSidebarConfig(implantacaoClienteSidebarConfig, modalImplantacaoClienteEl, "implantacao", implantacao, migracao);
  } else if (aba === "migracao") {
    if (!migracao) return;
    abrirConfigMigracaoCliente(implantacao, migracao);
    ativarSidebarConfig(migracaoSidebarConfig, modalMigracaoEl, "migracao", implantacao, migracao);
  } else {
    const loginAtual = fichaClienteAtual ? fichaClienteAtual.credencial_login : "";
    abrirModalFichaCredencial(implantacao.idcentral, loginAtual || "");
    ativarSidebarConfig(credencialSidebarConfig, modalFichaCredencialEl, "credenciais", implantacao, migracao);
  }
}

// implantacao/migracao: dados do cliente, pra decidir quais itens fazem
// sentido mostrar (ex.: cliente só-migração não tem o que editar em
// "Implantação"; "Credenciais SSX" fica sempre visível — todo cliente tem
// IdCentral). Chamado pelos 3 modais de configuração (Implantação, Migração,
// Credenciais) depois de abertos, pra manterem a mesma sidebar de navegação.
function ativarSidebarConfig(sidebarEl, modalEl, abaAtiva, implantacao, migracao) {
  sidebarEl.classList.remove("hidden");
  modalEl.classList.add("tem-sidebar-config");
  const itemImplantacao = sidebarEl.querySelector('[data-aba="implantacao"]');
  if (itemImplantacao) itemImplantacao.classList.toggle("hidden", !implantacao || implantacao.tem_implantacao === false);
  const itemMigracao = sidebarEl.querySelector('[data-aba="migracao"]');
  if (itemMigracao) itemMigracao.classList.toggle("hidden", !migracao);
  sidebarEl.querySelectorAll(".modal-sidebar-config-item").forEach((b) => {
    b.classList.toggle("ativo", b.dataset.aba === abaAtiva);
  });
}

function construirStepper(etapasOrdem, etapaLabels, etapaAtual) {
  const stepper = document.createElement("div");
  stepper.className = "stepper";
  const idxAtual = etapasOrdem.indexOf(etapaAtual);
  etapasOrdem.forEach((etapaId, idx) => {
    const item = document.createElement("div");
    const concluida = idxAtual > -1 && idx < idxAtual;
    const ativa = idx === idxAtual;
    item.className = "stepper-etapa" + (concluida ? " concluida" : "") + (ativa ? " ativa" : "");
    const bolha = document.createElement("div");
    bolha.className = "stepper-bolha";
    bolha.textContent = String(idx + 1);
    const nome = document.createElement("div");
    nome.className = "stepper-nome";
    nome.textContent = etapaLabels[etapaId] || etapaId;
    item.appendChild(bolha);
    item.appendChild(nome);
    stepper.appendChild(item);
  });
  return stepper;
}

// Legenda de prazo mostrada logo abaixo do stepper de Implantação — o stepper
// sozinho só diz EM QUE marco o cliente está, não se está no prazo. Mesma
// tabela de prazos (IMPLANTACAO_MARCO_PRAZOS) usada por marcoAtrasado.
function legendaProgressoImplantacao(implantacao) {
  if (implantacao.etapa === "concluido") {
    return { texto: "Todos os marcos concluídos.", classe: "concluido" };
  }
  const dias = diasDesdeEntrada(implantacao.data_entrada);
  const prazo = IMPLANTACAO_MARCO_PRAZOS[implantacao.etapa];
  if (dias === null || prazo === undefined) return null;

  const label = IMPLANTACAO_ETAPA_LABELS[implantacao.etapa] || implantacao.etapa;
  const diff = prazo - dias;
  if (diff < 0) return { texto: `${label} — venceu há ${Math.abs(diff)} dia${Math.abs(diff) === 1 ? "" : "s"}.`, classe: "atrasado" };
  if (diff === 0) return { texto: `${label} — vence hoje.`, classe: "atrasado" };
  return { texto: `${label} — vence em ${diff} dia${diff === 1 ? "" : "s"}.`, classe: "ok" };
}

function criarInfoItem(label, valor) {
  const item = document.createElement("div");
  item.className = "info-item";
  const l = document.createElement("div");
  l.className = "info-item-label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "info-item-valor";
  v.textContent = valor === null || valor === undefined || valor === "" ? "-" : String(valor);
  item.appendChild(l);
  item.appendChild(v);
  return item;
}

function classeFlagTag(flag) {
  if (flag === "Yellow Flag") return "tag-flag-yellow";
  if (flag === "Red Flag") return "tag-flag-red";
  if (flag === "Black Flag") return "tag-flag-black";
  return "tag-momento";
}

function criarTagResumo(texto, classeExtra) {
  const tag = document.createElement("span");
  tag.className = `tag-resumo ${classeExtra || ""}`;
  tag.textContent = texto;
  return tag;
}

// Número do decisor é texto livre (ex.: "(21) 99999-8888") — só extrai os
// dígitos e garante o DDI 55 na frente, senão o link do WhatsApp não abre.
function linkWhatsapp(numero) {
  const digitos = String(numero || "").replace(/\D/g, "");
  if (!digitos) return null;
  return `https://wa.me/${digitos.startsWith("55") ? digitos : `55${digitos}`}`;
}

function formatarMoeda(valor) {
  const n = Number(valor) || 0;
  if (!n) return "";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// data_entrada vem do <input type="date"> como "AAAA-MM-DD" — conta dias
// corridos até hoje (zera hora dos dois lados pra não variar por horário).
function diasDesdeEntrada(dataIso) {
  const partes = String(dataIso || "").split("-");
  if (partes.length !== 3) return null;
  const [ano, mes, dia] = partes.map(Number);
  const data = new Date(ano, mes - 1, dia);
  if (Number.isNaN(data.getTime())) return null;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  data.setHours(0, 0, 0, 0);
  return Math.round((hoje - data) / 86400000);
}

// Atraso de marco (Implantação) é checado em 3 lugares da Visão Geral (tag do
// cabeçalho, card de Atenção e callout do Progresso) — centraliza aqui pra não
// triplicar a mesma conta de dias.
function implantacaoAtrasada(implantacao) {
  return !!implantacao && implantacao.etapa !== "concluido"
    && marcoAtrasado(implantacao.data_entrada, implantacao.etapa, implantacao.marcos_concluidos);
}

function diasAtrasoImplantacao(implantacao) {
  const dias = diasDesdeEntrada(implantacao.data_entrada);
  const prazo = IMPLANTACAO_MARCO_PRAZOS[implantacao.etapa];
  return dias !== null && prazo !== undefined ? dias - prazo : null;
}

// IMPLANTACAO_ETAPA_LABELS já vem com o prazo embutido ("Marco 1 (7 dias)") —
// bom pro stepper, repetitivo num alerta de atraso que já diz "há N dias".
function nomeCurtoEtapaImplantacao(etapa) {
  return (IMPLANTACAO_ETAPA_LABELS[etapa] || etapa).replace(/\s*\([^)]*\)\s*$/, "");
}

// Valores de "Momento do Cliente" que por si só já indicam uma situação que
// precisa de atenção (trava operacional, risco de perda etc).
const FICHA_MOMENTOS_CRITICOS = ["Travado por Infraestrutura", "Possível Cancelamento", "Protestado", "Sumido"];

const ICONE_WHATSAPP_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91A9.85 9.85 0 0 0 12.04 2zm0 18.15h-.01a8.23 8.23 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.25-8.23a8.2 8.2 0 0 1 8.24 8.24c0 4.54-3.7 8.23-8.24 8.23zm4.52-6.16c-.25-.12-1.46-.72-1.69-.8-.23-.08-.39-.12-.56.12-.16.25-.64.8-.78.97-.14.16-.29.18-.54.06-.25-.12-1.04-.38-1.99-1.23-.73-.66-1.23-1.47-1.37-1.72-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.43.12-.14.16-.25.25-.41.08-.16.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.16 0-.43.06-.66.31-.23.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.16 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.46-.6 1.67-1.18.21-.58.21-1.07.14-1.18-.06-.1-.22-.16-.47-.28z"/></svg>';

// Ícones dos cards de contato (traço, 16px), mesmo estilo dos ícones da Ficha.
const ICONES_CONTATO = {
  pessoa: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="7" r="4"></circle><path d="M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2"></path></svg>',
  maleta: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>',
  pin: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>',
};

// Card de contato no padrão dos tiles da Ficha: ícone + rótulo, nome em
// destaque, detalhe opcional e o botão de WhatsApp da própria pessoa do card
// (nunca o número de outra).
function construirCardContato({ icone, rotulo, valor, vazio, detalhes, whatsapp }) {
  const card = document.createElement("div");
  card.className = "ficha-contato-card";

  const topo = document.createElement("div");
  topo.className = "ficha-contato-topo";
  topo.innerHTML = ICONES_CONTATO[icone] || "";
  const r = document.createElement("span");
  r.textContent = rotulo;
  topo.appendChild(r);
  card.appendChild(topo);

  const n = document.createElement("div");
  n.className = "ficha-contato-nome";
  n.textContent = valor || vazio;
  n.title = valor || "";
  card.appendChild(n);

  detalhes.filter(Boolean).forEach((texto) => {
    const d = document.createElement("div");
    d.className = "ficha-contato-detalhe";
    d.textContent = texto;
    card.appendChild(d);
  });

  const link = linkWhatsapp(whatsapp);
  if (link) {
    const btn = document.createElement("a");
    btn.className = "ficha-contato-wpp";
    btn.href = link;
    btn.target = "_blank";
    btn.rel = "noopener";
    btn.title = "Abrir conversa no WhatsApp";
    btn.setAttribute("aria-label", `WhatsApp: ${rotulo}`);
    btn.innerHTML = ICONE_WHATSAPP_SVG;
    card.appendChild(btn);
  }
  return card;
}

// Linha de cards da Visão Geral, lado a lado: CSM (quem da SystemSAT toca o
// cliente), Comercial (vendedor), Decisor (contato do cliente) e Região
// (cidade/estado do cliente, em card separado).
function construirFichaLinhaContato(implantacao) {
  const linha = document.createElement("div");
  linha.className = "ficha-contatos";

  linha.appendChild(construirCardContato({
    icone: "pessoa",
    rotulo: "CSM",
    valor: implantacao.csm,
    vazio: "não definido",
    detalhes: [],
    whatsapp: implantacao.csm_whatsapp,
  }));
  linha.appendChild(construirCardContato({
    icone: "maleta",
    rotulo: "Comercial",
    valor: implantacao.vendedor,
    vazio: "não definido",
    detalhes: [],
    whatsapp: implantacao.vendedor_whatsapp,
  }));
  linha.appendChild(construirCardContato({
    icone: "pessoa",
    rotulo: "Decisor",
    valor: implantacao.decisor_nome,
    vazio: "sem nome cadastrado",
    detalhes: [implantacao.decisor_whatsapp],
    whatsapp: implantacao.decisor_whatsapp,
  }));
  linha.appendChild(construirCardContato({
    icone: "pin",
    rotulo: "Região",
    valor: implantacao.decisor_cidade,
    vazio: "não definida",
    detalhes: [implantacao.decisor_estado],
    whatsapp: null,
  }));
  return linha;
}

// Junta num só lugar tudo que precisa da atenção do usuário — sem isso, cada
// sinal (atraso, momento crítico etc.) ficava espalhado pela tela e
// competindo com o resto da informação. Credencial SSX NÃO entra aqui: ela é
// só uma condição operacional (já mostrada, discreta, em Informações
// Operacionais) — vira alerta de verdade só nas abas Consulta e Importação,
// onde a falta dela realmente bloqueia a ação (ver construirFichaAvisoCredencial).
function coletarFichaAlertas(implantacao, migracao) {
  const alertas = [];
  if (implantacao) {
    if (implantacaoAtrasada(implantacao)) {
      const label = nomeCurtoEtapaImplantacao(implantacao.etapa);
      const diasAtraso = diasAtrasoImplantacao(implantacao);
      alertas.push({
        rotulo: "Marco atrasado",
        texto: diasAtraso !== null
          ? `${label} atrasado há ${diasAtraso} dia${diasAtraso === 1 ? "" : "s"}`
          : `${label} está atrasado`,
      });
    }
    // Mesma regra do selo "Parado" do Kanban (clienteParado).
    if (clienteParado(implantacao)) {
      alertas.push({
        rotulo: "Implantação parada",
        texto: `Sem atividade há ${diasSemAtividade(implantacao)} dias`,
      });
    }
    if (FICHA_MOMENTOS_CRITICOS.includes(implantacao.momento)) {
      alertas.push({ rotulo: "Momento do cliente", texto: implantacao.momento });
    }
  }
  return alertas;
}

function construirFichaAlertasCard(implantacao, migracao) {
  const card = document.createElement("div");
  card.className = "ficha-painel ficha-alertas";
  const h = document.createElement("h3");
  h.textContent = "Atenção";
  card.appendChild(h);

  const alertas = coletarFichaAlertas(implantacao, migracao);
  if (!alertas.length) {
    const p = document.createElement("p");
    p.className = "ficha-alertas-vazio";
    p.textContent = "🟢 Nenhuma pendência no momento.";
    card.appendChild(p);
    return card;
  }
  // Cada alerta vira um card no mesmo padrão dos contatos da Visão Geral.
  const grade = document.createElement("div");
  grade.className = "ficha-alertas-grade";
  alertas.forEach(({ rotulo, texto }) => {
    const item = document.createElement("div");
    item.className = "ficha-contato-card ficha-alerta-card";
    const r = document.createElement("div");
    r.className = "ficha-contato-rotulo";
    r.textContent = rotulo;
    const t = document.createElement("div");
    t.className = "ficha-alerta-texto";
    t.textContent = texto;
    item.appendChild(r);
    item.appendChild(t);
    grade.appendChild(item);
  });
  card.appendChild(grade);
  if (implantacaoAtrasada(implantacao)) card.appendChild(construirBlocoMotivoAtraso(implantacao));
  return card;
}

// Motivo do atraso (árvore de decisão do Playbook): mostra o motivo + ação
// sugerida quando já tem; senão (ou ao clicar em Alterar) pede o motivo.
function construirBlocoMotivoAtraso(implantacao) {
  const bloco = document.createElement("div");
  bloco.className = "motivo-atraso";
  const atual = motivoAtrasoAtual(implantacao);

  function mostrarResumo(m) {
    bloco.innerHTML = "";
    const info = MOTIVOS_ATRASO[m.motivo];
    const linha = document.createElement("div");
    linha.className = "motivo-atraso-linha";
    linha.innerHTML = "<strong>Motivo do atraso:</strong> ";
    linha.appendChild(document.createTextNode(info.rotulo));
    const btnAlterar = document.createElement("button");
    btnAlterar.type = "button";
    btnAlterar.className = "btn-link-inline";
    btnAlterar.textContent = "Alterar";
    btnAlterar.addEventListener("click", () => mostrarFormulario(m));
    linha.appendChild(btnAlterar);
    bloco.appendChild(linha);
    const acao = document.createElement("div");
    acao.className = "motivo-atraso-acao";
    acao.textContent = `Ação sugerida: ${info.acao}`;
    bloco.appendChild(acao);
    if (m.obs) {
      const obs = document.createElement("div");
      obs.className = "motivo-atraso-meta";
      obs.textContent = `Obs.: ${m.obs}`;
      bloco.appendChild(obs);
    }
    const meta = document.createElement("div");
    meta.className = "motivo-atraso-meta";
    meta.textContent = `Registrado${m.por ? ` por ${m.por}` : ""} em ${formatarDataBRSimples(m.em) || m.em}`;
    bloco.appendChild(meta);
  }

  function mostrarFormulario(m) {
    bloco.innerHTML = "";
    const rotulo = document.createElement("div");
    rotulo.className = "motivo-atraso-linha";
    rotulo.innerHTML = "<strong>Por que o cliente não está avançando?</strong>";
    bloco.appendChild(rotulo);
    const form = document.createElement("div");
    form.className = "motivo-atraso-form";
    const select = document.createElement("select");
    select.innerHTML = '<option value="">Escolha o motivo...</option>';
    Object.entries(MOTIVOS_ATRASO).forEach(([valor, info]) => {
      const opt = document.createElement("option");
      opt.value = valor;
      opt.textContent = info.rotulo;
      select.appendChild(opt);
    });
    select.value = m ? m.motivo : "";
    const obs = document.createElement("input");
    obs.type = "text";
    obs.placeholder = "Observação (opcional)";
    obs.maxLength = 300;
    obs.value = m ? (m.obs || "") : "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-primary";
    btn.textContent = "Salvar";
    const dica = document.createElement("div");
    dica.className = "motivo-atraso-acao";
    const atualizarDica = () => {
      const info = MOTIVOS_ATRASO[select.value];
      dica.textContent = info ? `Ação sugerida: ${info.acao}` : "";
    };
    select.addEventListener("change", atualizarDica);
    atualizarDica();
    btn.addEventListener("click", async () => {
      if (!select.value) return alert("Escolha o motivo.");
      btn.disabled = true;
      try {
        const r = await fetch(`/api/clientes/${implantacao.id}/motivo-atraso`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ motivo: select.value, obs: obs.value }),
        });
        const data = await parseJsonResponse(r);
        if (!data.ok) return alert(`Erro ao salvar: ${data.error || "falha desconhecida"}`);
        implantacao.motivo_atraso = data.motivo_atraso;
        // Mantém a lista da Implantação/busca em dia sem reler do servidor.
        const noCache = implantacaoClientesCache.find((c) => c.id === implantacao.id);
        if (noCache) noCache.motivo_atraso = data.motivo_atraso;
        mostrarResumo(data.motivo_atraso);
      } catch (err) {
        alert(`Erro ao salvar: ${String(err)}`);
      } finally {
        btn.disabled = false;
      }
    });
    form.appendChild(select);
    form.appendChild(obs);
    form.appendChild(btn);
    bloco.appendChild(form);
    bloco.appendChild(dica);
    if (m) {
      const cancelar = document.createElement("button");
      cancelar.type = "button";
      cancelar.className = "btn-link-inline";
      cancelar.textContent = "Cancelar";
      cancelar.addEventListener("click", () => mostrarResumo(m));
      bloco.appendChild(cancelar);
    }
  }

  if (atual) mostrarResumo(atual); else mostrarFormulario(null);
  return bloco;
}

// "Resumo do cliente" — mesmos dados do grid antigo, só que agora com título
// próprio e emparelhado com a sidebar de Tarefas (construirFichaTarefasPainel).
function construirFichaResumoCard(implantacao, migracao) {
  const card = document.createElement("div");
  card.className = "ficha-painel";
  const h = document.createElement("h3");
  h.textContent = "Resumo do cliente";
  card.appendChild(h);

  const grid = document.createElement("div");
  grid.className = "info-grid";
  if (implantacao) {
    grid.appendChild(criarInfoItem("IdCentral", implantacao.idcentral));
    grid.appendChild(criarInfoItem("Responsável", implantacao.csm));
    // Resto é da jornada de Implantação (data de entrada, objetivo, valor de
    // contrato...) — não existe pra um cliente que só tem Migração.
    if (implantacao.tem_implantacao !== false) {
      grid.appendChild(criarInfoItem("Data de entrada", implantacao.data_entrada));
      const dias = diasDesdeEntrada(implantacao.data_entrada);
      grid.appendChild(criarInfoItem("Dias desde a entrada", dias === null ? "" : `${dias} dia${dias === 1 ? "" : "s"}`));
      const diasSemAcao = diasSemAtividade(implantacao);
      grid.appendChild(criarInfoItem("Dias sem atividade", diasSemAcao === null ? "Sem registro" : `${diasSemAcao} dia${diasSemAcao === 1 ? "" : "s"}`));
      grid.appendChild(criarInfoItem("Vendedor", implantacao.vendedor));
      grid.appendChild(criarInfoItem("Objetivo", implantacao.objetivo));
      grid.appendChild(criarInfoItem("Valor de contrato", formatarMoeda(implantacao.valor_contrato)));
    }
  }
  if (migracao) grid.appendChild(criarInfoItem("Plataforma de origem (Migração)", migracao.plataforma_origem));
  card.appendChild(grid);
  return card;
}

// Sidebar de Tarefas da Visão Geral — mesmo conceito visual do painel de
// Tarefas de "Minha Conta" (reaproveita as classes .minha-conta-*): lista
// compacta, poucas tarefas por padrão, "Ver mais" pra pendentes extras e pra
// concluídas, sem nunca ocupar a largura toda da tela.
function construirFichaTarefasPainel(implantacao) {
  const painel = document.createElement("div");
  painel.className = "minha-conta-painel-tarefas ficha-painel-tarefas";

  const topo = document.createElement("div");
  topo.className = "minha-conta-tarefas-topo";
  const h = document.createElement("h3");
  h.textContent = "Tarefas";
  const badge = document.createElement("span");
  badge.className = "minha-conta-tarefas-badge";
  badge.textContent = "0";
  h.appendChild(badge);
  topo.appendChild(h);
  const btnNova = document.createElement("button");
  btnNova.type = "button";
  btnNova.className = "btn-primary";
  btnNova.textContent = "+ Nova tarefa";
  topo.appendChild(btnNova);
  painel.appendChild(topo);

  const lista = document.createElement("div");
  lista.className = "minha-conta-tarefas-lista";
  painel.appendChild(lista);

  const btnMaisPendentes = document.createElement("button");
  btnMaisPendentes.type = "button";
  btnMaisPendentes.className = "minha-conta-link-concluidas hidden";
  painel.appendChild(btnMaisPendentes);

  const btnConcluidas = document.createElement("button");
  btnConcluidas.type = "button";
  btnConcluidas.className = "minha-conta-link-concluidas hidden";
  painel.appendChild(btnConcluidas);

  const LIMITE_INICIAL = 4;
  let mostrarTodasPendentes = false;
  let mostrarConcluidas = false;

  const recarregar = async () => {
    lista.innerHTML = '<p class="placeholder">Carregando...</p>';
    try {
      const r = await fetch(`/api/tarefas?cliente_id=${encodeURIComponent(implantacao.id)}`);
      const data = await parseJsonResponse(r);
      lista.innerHTML = "";
      if (!data.ok) {
        const p = document.createElement("p");
        p.className = "placeholder";
        p.textContent = `Erro: ${data.error || "falha ao carregar tarefas"}`;
        lista.appendChild(p);
        badge.textContent = "0";
        btnMaisPendentes.classList.add("hidden");
        btnConcluidas.classList.add("hidden");
        return;
      }

      const todas = data.tarefas || [];
      const pendentes = todas.filter((t) => !t.concluida);
      const concluidas = todas.filter((t) => t.concluida);
      badge.textContent = String(pendentes.length);

      if (!todas.length) {
        const p = document.createElement("p");
        p.className = "placeholder";
        p.textContent = "Nenhuma tarefa.";
        lista.appendChild(p);
        btnMaisPendentes.classList.add("hidden");
        btnConcluidas.classList.add("hidden");
        return;
      }

      const pendentesVisiveis = mostrarTodasPendentes ? pendentes : pendentes.slice(0, LIMITE_INICIAL);
      if (pendentesVisiveis.length) {
        lista.appendChild(construirListaTarefas(pendentesVisiveis, {
          compacta: true,
          mostrarResponsavel: true,
          aoMudar: recarregar,
          aoClicar: (t) => abrirDetalhesTarefa(t, recarregar),
        }));
      } else {
        const p = document.createElement("p");
        p.className = "placeholder";
        p.textContent = "Nenhuma tarefa pendente.";
        lista.appendChild(p);
      }

      if (mostrarConcluidas && concluidas.length) {
        lista.appendChild(construirListaTarefas(concluidas, {
          compacta: true,
          mostrarResponsavel: true,
          aoMudar: recarregar,
          aoClicar: (t) => abrirDetalhesTarefa(t, recarregar),
        }));
      }

      const restantes = mostrarTodasPendentes ? 0 : Math.max(0, pendentes.length - LIMITE_INICIAL);
      if (restantes) {
        btnMaisPendentes.textContent = `Ver mais ${restantes} pendente${restantes === 1 ? "" : "s"}`;
        btnMaisPendentes.classList.remove("hidden");
      } else {
        btnMaisPendentes.classList.add("hidden");
      }

      if (concluidas.length) {
        btnConcluidas.textContent = mostrarConcluidas ? "Ocultar tarefas concluídas" : `Ver tarefas concluídas (${concluidas.length})`;
        btnConcluidas.classList.remove("hidden");
      } else {
        btnConcluidas.classList.add("hidden");
      }
    } catch (err) {
      lista.innerHTML = "";
    }
  };

  btnNova.addEventListener("click", () => abrirModalTarefa({ clienteId: implantacao.id, aoSalvar: recarregar }));
  btnMaisPendentes.addEventListener("click", () => { mostrarTodasPendentes = true; recarregar(); });
  btnConcluidas.addEventListener("click", () => { mostrarConcluidas = !mostrarConcluidas; recarregar(); });

  recarregar();
  return painel;
}

// Progresso — um bloco por cadastro (Implantação/Migração), cada um só com o
// stepper e, quando existir atraso, um callout curto acima dele. Sem atraso,
// não tem texto nenhum: o stepper já mostra em que marco o cliente está.
function construirFichaProgressoCard(implantacao, migracao) {
  const temImplantacao = implantacao && implantacao.tem_implantacao !== false;
  if (!temImplantacao && !migracao) return null;
  const card = document.createElement("div");
  card.className = "ficha-painel";
  const h = document.createElement("h3");
  h.textContent = "Progresso";
  card.appendChild(h);

  if (temImplantacao) {
    const bloco = document.createElement("div");
    bloco.className = "ficha-progresso-bloco";
    const titulo = document.createElement("div");
    titulo.className = "ficha-progresso-titulo";
    const h4 = document.createElement("h4");
    h4.textContent = "Implantação";
    titulo.appendChild(h4);
    bloco.appendChild(titulo);

    if (implantacaoAtrasada(implantacao)) {
      const label = nomeCurtoEtapaImplantacao(implantacao.etapa);
      const diasAtraso = diasAtrasoImplantacao(implantacao);
      const p = document.createElement("p");
      p.className = "progresso-alerta-atraso";
      p.textContent = diasAtraso !== null
        ? `🔴 ${label} atrasado há ${diasAtraso} dia${diasAtraso === 1 ? "" : "s"}`
        : `🔴 ${label} atrasado`;
      bloco.appendChild(p);
    }
    bloco.appendChild(construirStepper(IMPLANTACAO_ETAPAS_ORDEM, IMPLANTACAO_ETAPA_LABELS, implantacao.etapa));
    // O stepper usa os rótulos curtos do Kanban; o nome do marco atual (e de
    // quem é a responsabilidade) aparece por extenso só aqui na Ficha.
    const info = IMPLANTACAO_MARCOS_INFO[implantacao.etapa];
    if (info) {
      const atual = document.createElement("p");
      atual.className = "ficha-marco-atual";
      atual.textContent = `Agora: ${nomeCompletoMarco(implantacao.etapa)} · responsabilidade de ${info.dono} `;
      const btnMarcos = document.createElement("button");
      btnMarcos.type = "button";
      btnMarcos.className = "btn-link-inline";
      btnMarcos.textContent = "Abrir marcos →";
      btnMarcos.addEventListener("click", () => mostrarFichaAba("marcos"));
      atual.appendChild(btnMarcos);
      bloco.appendChild(atual);
    }
    card.appendChild(bloco);
  }

  if (migracao) {
    const bloco = document.createElement("div");
    bloco.className = "ficha-progresso-bloco";
    const titulo = document.createElement("div");
    titulo.className = "ficha-progresso-titulo";
    const h4 = document.createElement("h4");
    h4.textContent = "Migração";
    titulo.appendChild(h4);
    if (migracao.percentual_migracao) {
      const pct = document.createElement("span");
      pct.className = "ficha-progresso-pct";
      pct.textContent = `${migracao.percentual_migracao}%`;
      titulo.appendChild(pct);
    }
    bloco.appendChild(titulo);
    bloco.appendChild(construirStepper(MIGRACAO_ETAPAS_ORDEM, MIGRACAO_ETAPA_LABELS, migracao.etapa));
    card.appendChild(bloco);
  }

  return card;
}

// Status compacto da Credencial SSX, na Visão Geral (uma linha, sem cartão
// grande) — só cadastro (admin-only); autenticar e usar a credencial (Consulta,
// Importação) saíram da Ficha e agora vivem na Central de Importação SSX, que
// lê esse mesmo cadastro pelos Logins salvos.
function construirFichaCredencialCompacta(idcentral, credencialConfigurada, credencialLogin) {
  const wrap = document.createElement("div");
  wrap.className = "ficha-operacional-bloco";

  const linha = document.createElement("div");
  linha.className = "credencial-compacta";

  const status = document.createElement("span");
  if (!credencialConfigurada) {
    status.className = "credencial-compacta-erro";
    status.textContent = "🔴 Credencial SSX — Não cadastrada";
  } else {
    status.className = "credencial-compacta-ok";
    status.textContent = "🟢 Credencial SSX — Cadastrada";
  }
  linha.appendChild(status);

  if (USUARIO_PERFIL_ATUAL === "adm" && credencialLogin) {
    const loginTxt = document.createElement("span");
    loginTxt.className = "ficha-credencial-login";
    loginTxt.textContent = credencialLogin;
    linha.appendChild(loginTxt);
  }

  if (USUARIO_PERFIL_ATUAL === "adm") {
    const btnEditar = document.createElement("button");
    btnEditar.type = "button";
    btnEditar.className = "btn-secondary";
    btnEditar.textContent = credencialConfigurada ? "Editar credencial" : "Cadastrar credencial";
    btnEditar.addEventListener("click", () => abrirModalFichaCredencial(idcentral, credencialLogin || ""));
    linha.appendChild(btnEditar);
  }

  wrap.appendChild(linha);
  return wrap;
}

// Bloco de menor prioridade visual (recolhível) com credencial + indicadores
// da planilha de CS — informação técnica/operacional que nem sempre precisa
// estar aberta, mas continua disponível sem sumir da tela.
function construirFichaOperacionalCard(idcentral, implantacao, credencialConfigurada, credencialLogin) {
  const det = document.createElement("details");
  det.className = "ficha-painel ficha-operacional";
  det.open = true;
  const summary = document.createElement("summary");
  summary.textContent = "Informações operacionais";
  det.appendChild(summary);

  det.appendChild(construirFichaCredencialCompacta(idcentral, credencialConfigurada, credencialLogin));

  // Indicadores que só existem depois de uma Sincronizar Planilha (Ferramentas
  // Auxiliares) — cliente que nunca sincronizou não tem "dados_planilha" no
  // cadastro, então essa seção simplesmente não aparece (nada de placeholder
  // vazio). Valor "-" da planilha (célula sem preenchimento) também não conta
  // como dado de verdade, então não vira item aqui.
  if (implantacao && implantacao.dados_planilha) {
    const dp = implantacao.dados_planilha;
    const valorUtil = (v) => (v && v !== "-" ? v : null);
    const itensIndicadores = [
      ["Cidade/Estado", [implantacao.decisor_cidade, implantacao.decisor_estado].filter(Boolean).join(" - ") || null],
      ["% Veículos desatualizados", valorUtil(dp["9 - % veiculos desatualizados"])],
      ["Rastreadores desatualizados", valorUtil(dp["10 - Rasteadores desatualizados"])],
      ["Último boleto", valorUtil(dp["6 - Ultimo boleto"])],
      ["Consumo", valorUtil(dp["57 - consumo"])],
      ["Delta uso x paga", valorUtil(dp["Delta Uso x paga"])],
      ["Dias desde último contato (planilha)", (() => {
        const d = valorUtil(dp["13 - Dias do ultimo contato"]);
        return d === null ? null : `${d} dia${d === "1" ? "" : "s"}`;
      })()],
    ].filter(([, valor]) => valor !== null);

    if (itensIndicadores.length) {
      const secIndicadores = document.createElement("div");
      secIndicadores.className = "ficha-operacional-bloco";
      const hInd = document.createElement("h4");
      hInd.textContent = "Indicadores (planilha de CS)";
      secIndicadores.appendChild(hInd);
      const gridInd = document.createElement("div");
      gridInd.className = "info-grid";
      itensIndicadores.forEach(([label, valor]) => gridInd.appendChild(criarInfoItem(label, valor)));
      secIndicadores.appendChild(gridInd);
      det.appendChild(secIndicadores);
    }
  }

  return det;
}

// Sub-abas acima do nome do cliente, dentro da Visão Geral. Cada uma mostra um
// recorte: "Geral" é o painel completo; as outras separam o que é cadastro e
// andamento (Histórico tem aba própria no sidebar, fora da Visão Geral).
const FICHA_SUB_ABAS = [
  ["geral", "Geral"],
  ["informacoes", "Informações do Cliente"],
  ["progresso", "Progresso"],
];
let fichaSubAbaAtual = "geral";

function construirFichaSubAbas(ativa) {
  const nav = document.createElement("div");
  nav.className = "ficha-subabas";
  nav.setAttribute("role", "tablist");
  FICHA_SUB_ABAS.forEach(([chave, rotulo]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ficha-subaba" + (chave === ativa ? " ativo" : "");
    btn.textContent = rotulo;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(chave === ativa));
    btn.addEventListener("click", () => {
      if (chave === fichaSubAbaAtual) return;
      fichaSubAbaAtual = chave;
      mostrarFichaAba("geral");
    });
    nav.appendChild(btn);
  });
  return nav;
}

// --- Aba Timeline (Histórico da Ficha) ---
// "Caminho do cliente" em zigue-zague, mesmo formato do Acompanhamento de
// Cliente do kanban_dashboard_dev — mas sem busca de cliente: usa sempre o
// cliente da própria Ficha (implantacao.id). Eventos vêm do mesmo
// /api/clientes/<id>/eventos já usado pela linha do tempo em modal
// (abrirTimelineImplantacao) — não duplica cadastro, só a visualização.
let fichaTimelineFiltroTag = "";
let fichaTimelineClienteIdCache = null;
let fichaTimelineEventosCache = [];

async function obterFichaTimelineEventos(clienteId, forcarRecarga) {
  if (!forcarRecarga && fichaTimelineClienteIdCache === clienteId) return fichaTimelineEventosCache;
  const r = await fetch(`/api/clientes/${encodeURIComponent(clienteId)}/eventos`);
  const data = await parseJsonResponse(r);
  fichaTimelineClienteIdCache = clienteId;
  fichaTimelineEventosCache = data.ok ? (data.eventos || []) : [];
  return fichaTimelineEventosCache;
}

// Diferença em dias corridos entre duas datas "AAAA-MM-DD" (sem hora, pra não
// variar por fuso) — mesma ideia de diasDesdeEntrada, mas entre duas datas
// quaisquer em vez de "até hoje".
function diasEntreDatasIso(dataA, dataB) {
  const partesA = String(dataA || "").split("-");
  const partesB = String(dataB || "").split("-");
  if (partesA.length !== 3 || partesB.length !== 3) return null;
  const [anoA, mesA, diaA] = partesA.map(Number);
  const [anoB, mesB, diaB] = partesB.map(Number);
  const a = new Date(anoA, mesA - 1, diaA);
  const b = new Date(anoB, mesB - 1, diaB);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}

function construirFichaTimelineGap(dias) {
  const gap = document.createElement("span");
  gap.className = "ficha-timeline-gap";
  gap.textContent = dias === null ? "" : `${dias} dia${Math.abs(dias) === 1 ? "" : "s"}`;
  return gap;
}

function construirFichaTimelineItem(ev) {
  const item = document.createElement("div");
  item.className = "ficha-timeline-item";

  const data = document.createElement("span");
  data.className = "ficha-timeline-item-data";
  data.textContent = formatarDataBRSimples(ev.data) || "Sem data";
  item.appendChild(data);

  const bolinha = document.createElement("button");
  bolinha.type = "button";
  bolinha.className = "ficha-timeline-item-bolinha";
  bolinha.style.backgroundColor = (ev.tag && EVENTO_TAG_COR[ev.tag]) || EVENTO_TAG_COR_PADRAO;
  bolinha.setAttribute("aria-expanded", "false");
  bolinha.title = `Abrir detalhes: ${ev.titulo}`;
  item.appendChild(bolinha);

  const rotulo = document.createElement("p");
  rotulo.className = "ficha-timeline-item-rotulo";
  rotulo.textContent = ev.titulo;
  item.appendChild(rotulo);

  const detalhe = document.createElement("div");
  detalhe.className = "ficha-timeline-item-detalhe hidden";
  const dTitulo = document.createElement("p");
  dTitulo.className = "ficha-timeline-item-detalhe-titulo";
  dTitulo.textContent = "Detalhes do acontecimento";
  detalhe.appendChild(dTitulo);
  [
    ["Setor", ev.setor || "—"],
    ["Tag", ev.tag || "Sem tag"],
    ["Descrição", ev.descricao || "—"],
    ["CSM", ev.responsavel || "Não informado"],
  ].forEach(([rotuloCampo, valor]) => {
    const p = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = `${rotuloCampo}: `;
    p.appendChild(strong);
    p.appendChild(document.createTextNode(valor));
    detalhe.appendChild(p);
  });
  item.appendChild(detalhe);

  bolinha.addEventListener("click", () => {
    const vaiAbrir = detalhe.classList.contains("hidden");
    detalhe.classList.toggle("hidden", !vaiAbrir);
    bolinha.setAttribute("aria-expanded", String(vaiAbrir));
  });

  return item;
}

const FICHA_TIMELINE_ITENS_POR_LINHA = 4;

// Monta o "Caminho do cliente": linhas de N eventos em zigue-zague (linha par
// → esquerda pra direita, ímpar → invertida), com o marcador "Início" antes
// do primeiro evento, um badge de dias entre cada par de eventos consecutivos
// (dentro da linha ou no conector entre linhas) e detalhe que expande ao
// clicar na bolinha.
function renderFichaTimelineCaminho(container, contadorEl, eventosTodos, filtroTag) {
  const eventos = (eventosTodos || [])
    .filter((ev) => !filtroTag || ev.tag === filtroTag)
    .slice()
    .sort((a, b) => String(a.data || "").localeCompare(String(b.data || "")));

  contadorEl.textContent = `${eventos.length} acontecimento${eventos.length === 1 ? "" : "s"}`;

  container.innerHTML = "";
  if (!eventos.length) {
    container.appendChild(construirFichaHistoricoVazio(
      "Nenhum acontecimento ainda",
      filtroTag ? `Nenhum acontecimento com a tag "${filtroTag}" registrado.` : 'Clique em "Editar acontecimentos" pra começar a registrar.'
    ));
    return;
  }

  const linhas = [];
  for (let i = 0; i < eventos.length; i += FICHA_TIMELINE_ITENS_POR_LINHA) {
    linhas.push(eventos.slice(i, i + FICHA_TIMELINE_ITENS_POR_LINHA));
  }

  linhas.forEach((eventosDaLinha, idxLinha) => {
    const invertida = idxLinha % 2 === 1;
    const linha = document.createElement("div");
    linha.className = "ficha-timeline-linha" + (invertida ? " invertida" : "");

    if (idxLinha === 0) {
      const inicio = document.createElement("div");
      inicio.className = "ficha-timeline-inicio";
      const rotuloInicio = document.createElement("span");
      rotuloInicio.className = "ficha-timeline-inicio-rotulo";
      rotuloInicio.textContent = "Início";
      const bolinhaInicio = document.createElement("span");
      bolinhaInicio.className = "ficha-timeline-inicio-bolinha";
      inicio.appendChild(rotuloInicio);
      inicio.appendChild(bolinhaInicio);
      linha.appendChild(inicio);
    }

    eventosDaLinha.forEach((ev, idxNaLinha) => {
      if (idxNaLinha > 0) {
        linha.appendChild(construirFichaTimelineGap(diasEntreDatasIso(eventosDaLinha[idxNaLinha - 1].data, ev.data)));
      }
      linha.appendChild(construirFichaTimelineItem(ev));
    });

    container.appendChild(linha);

    const proximaLinha = linhas[idxLinha + 1];
    if (proximaLinha) {
      const conector = document.createElement("div");
      conector.className = "ficha-timeline-conector " + (invertida ? "esquerda" : "direita");
      const ultimoDaLinha = eventosDaLinha[eventosDaLinha.length - 1];
      conector.appendChild(construirFichaTimelineGap(diasEntreDatasIso(ultimoDaLinha.data, proximaLinha[0].data)));
      container.appendChild(conector);
    }
  });
}

async function carregarFichaTimeline(implantacao, forcarRecarga, card) {
  const contadorEl = card._fichaTimelineContador;
  const caminhoWrap = card._fichaTimelineCaminhoWrap;
  caminhoWrap.innerHTML = '<p class="placeholder">Carregando...</p>';
  try {
    const eventos = await obterFichaTimelineEventos(implantacao.id, forcarRecarga);
    renderFichaTimelineCaminho(caminhoWrap, contadorEl, eventos, fichaTimelineFiltroTag);
  } catch (err) {
    mostrarErroEmNode(caminhoWrap, String(err));
  }
}

// Estado vazio padrão das abas da Histórico (sem Implantação, área sem
// registro ainda etc.) — cartão discreto com ícone, em vez de um parágrafo
// solto, pra manter a mesma linguagem visual em toda a aba.
function construirFichaHistoricoVazio(titulo, texto) {
  const vazio = document.createElement("div");
  vazio.className = "ficha-historico-vazio";
  vazio.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>';
  const h4 = document.createElement("p");
  h4.className = "ficha-historico-vazio-titulo";
  h4.textContent = titulo;
  vazio.appendChild(h4);
  if (texto) {
    const p = document.createElement("p");
    p.className = "ficha-historico-vazio-texto";
    p.textContent = texto;
    vazio.appendChild(p);
  }
  return vazio;
}

function construirFichaTimelineCard(implantacao) {
  const card = document.createElement("div");
  card.className = "ficha-painel";

  if (!implantacao) {
    card.appendChild(construirFichaHistoricoVazio(
      "Sem Implantação",
      "Esse cliente não tem Implantação — não há linha do tempo pra mostrar."
    ));
    return card;
  }

  const toolbar = document.createElement("div");
  toolbar.className = "ficha-timeline-toolbar";

  const legenda = document.createElement("div");
  legenda.className = "ficha-timeline-legenda";
  const legendaTitulo = document.createElement("span");
  legendaTitulo.className = "ficha-timeline-legenda-titulo";
  legendaTitulo.textContent = "TAGS";
  legenda.appendChild(legendaTitulo);
  EVENTO_TAGS.forEach(([nome, cor]) => {
    const item = document.createElement("span");
    item.className = "ficha-timeline-legenda-item";
    const bolinha = document.createElement("span");
    bolinha.className = "ficha-timeline-legenda-bolinha";
    bolinha.style.backgroundColor = cor;
    item.appendChild(bolinha);
    item.appendChild(document.createTextNode(nome));
    legenda.appendChild(item);
  });
  toolbar.appendChild(legenda);

  const acoes = document.createElement("div");
  acoes.className = "ficha-timeline-toolbar-acoes";

  const btnAtualizar = document.createElement("button");
  btnAtualizar.type = "button";
  btnAtualizar.className = "btn-secondary";
  btnAtualizar.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg><span>Atualizar</span>';
  btnAtualizar.addEventListener("click", () => carregarFichaTimeline(implantacao, true, card));
  acoes.appendChild(btnAtualizar);

  const selectTag = document.createElement("select");
  selectTag.className = "ficha-timeline-filtro-tag";
  const optTodas = document.createElement("option");
  optTodas.value = "";
  optTodas.textContent = "Todas as Tags";
  selectTag.appendChild(optTodas);
  EVENTO_TAGS.forEach(([nome]) => {
    const opt = document.createElement("option");
    opt.value = nome;
    opt.textContent = nome;
    selectTag.appendChild(opt);
  });
  selectTag.value = fichaTimelineFiltroTag;
  selectTag.addEventListener("change", () => {
    fichaTimelineFiltroTag = selectTag.value;
    renderFichaTimelineCaminho(card._fichaTimelineCaminhoWrap, card._fichaTimelineContador, fichaTimelineEventosCache, fichaTimelineFiltroTag);
  });
  acoes.appendChild(selectTag);

  const btnEditar = document.createElement("button");
  btnEditar.type = "button";
  btnEditar.className = "btn-secondary";
  btnEditar.textContent = "Editar acontecimentos";
  btnEditar.title = "Adicionar, editar ou excluir acontecimentos (abre por setor)";
  btnEditar.addEventListener("click", () => abrirTimelineImplantacao(implantacao));
  acoes.appendChild(btnEditar);

  toolbar.appendChild(acoes);
  card.appendChild(toolbar);

  const corpo = document.createElement("div");
  corpo.className = "ficha-timeline-corpo";
  card.appendChild(corpo);

  const cabecalho = document.createElement("div");
  cabecalho.className = "ficha-timeline-cabecalho";
  const tituloCaminho = document.createElement("div");
  tituloCaminho.className = "ficha-timeline-cabecalho-titulo";
  tituloCaminho.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 13v8"></path><path d="M12 3v3"></path><path d="M4 6a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h13a2 2 0 0 0 1.152-.365l3.424-2.317a1 1 0 0 0 0-1.635l-3.424-2.318A2 2 0 0 0 17 6z"></path></svg><span>Caminho do cliente</span>';
  cabecalho.appendChild(tituloCaminho);
  const contador = document.createElement("span");
  contador.className = "ficha-timeline-contador";
  cabecalho.appendChild(contador);
  corpo.appendChild(cabecalho);

  const caminhoWrap = document.createElement("div");
  caminhoWrap.className = "ficha-timeline-caminho";
  corpo.appendChild(caminhoWrap);

  card._fichaTimelineContador = contador;
  card._fichaTimelineCaminhoWrap = caminhoWrap;

  if (fichaTimelineClienteIdCache === implantacao.id) {
    renderFichaTimelineCaminho(caminhoWrap, contador, fichaTimelineEventosCache, fichaTimelineFiltroTag);
  } else {
    caminhoWrap.innerHTML = '<p class="placeholder">Carregando...</p>';
    carregarFichaTimeline(implantacao, false, card);
  }

  return card;
}

// --- Aba Detalhado (Histórico da Ficha) — eventos em formato de chat ---
// Mesmos eventos da Timeline (/api/clientes/<id>/eventos, cache
// compartilhado via obterFichaTimelineEventos) + as tentativas de migração
// "traduzidas" em eventos sintéticos (tag "Migração", não gravados no
// backend) — tudo numa lista só, ordenada por data crescente (mais antigo no
// topo, mais recente embaixo), aberta já rolada pro final. Um composer fixo
// embaixo registra um novo acontecimento de verdade, com os mesmos campos do
// modal de acontecimento (Setor/Título/Tag/Descrição/Data/Responsável).

// Início/fim de uma tentativa de migração viram "acontecimentos" de leitura
// (sem id real no backend — nunca editáveis/excluíveis por aqui), pra
// aparecerem misturados aos outros no mesmo chat cronológico.
function construirEventosSinteticosMigracao(migracoes) {
  const eventos = [];
  (migracoes || []).forEach((m) => {
    if (m.data_inicio) {
      eventos.push({
        id: `sintetico-mig-inicio-${m.id}`,
        setor: "Migração",
        tag: "Migração",
        titulo: "Migração iniciada",
        descricao: m.motivo ? `Motivo: ${m.motivo}` : "",
        data: m.data_inicio,
        responsavel: "",
        sintetico: true,
      });
    }
    if (m.data_fim) {
      eventos.push({
        id: `sintetico-mig-fim-${m.id}`,
        setor: "Migração",
        tag: "Migração",
        titulo: `Migração ${MIGRACAO_STATUS_LABELS[m.status] || m.status}`,
        descricao: m.motivo ? `Motivo: ${m.motivo}` : "",
        data: m.data_fim,
        responsavel: "",
        sintetico: true,
      });
    }
  });
  return eventos;
}

function montarFichaChatEventos(eventosReais, migracoes) {
  return (eventosReais || [])
    .concat(construirEventosSinteticosMigracao(migracoes))
    .slice()
    .sort((a, b) => String(a.data || "").localeCompare(String(b.data || "")));
}

// Cor da bolinha do rail (timeline à esquerda do chat) — mesma lógica de
// prioridade que antes virava borda do cartão: Tag primeiro, senão Setor.
function corFichaChatEvento(ev) {
  return ev.tag ? (EVENTO_TAG_COR[ev.tag] || EVENTO_TAG_COR_PADRAO) : (IMPLANTACAO_SETOR_COR[ev.setor] || "var(--cinza-300)");
}

function construirFichaChatMensagem(ev) {
  const bolha = document.createElement("div");
  bolha.className = "ficha-chat-mensagem" + (ev.sintetico ? " sintetico" : "");

  const topo = document.createElement("div");
  topo.className = "ficha-chat-mensagem-topo";

  const setorSpan = document.createElement("span");
  setorSpan.className = "ficha-chat-mensagem-setor";
  setorSpan.textContent = ev.setor || "—";
  topo.appendChild(setorSpan);

  if (ev.tag) {
    const chip = EVENTO_TAG_CHIP[ev.tag];
    const tagSpan = document.createElement("span");
    tagSpan.className = "ficha-chat-mensagem-tag";
    tagSpan.style.backgroundColor = chip ? chip.bg : "var(--cinza-100)";
    tagSpan.style.color = chip ? chip.fg : "var(--cinza-700)";
    tagSpan.textContent = ev.tag;
    topo.appendChild(tagSpan);
  }

  if (ev.sintetico) {
    const sinteticoSpan = document.createElement("span");
    sinteticoSpan.className = "ficha-chat-mensagem-sintetico-rotulo";
    sinteticoSpan.textContent = "registrado no cadastro de migração";
    topo.appendChild(sinteticoSpan);
  }
  bolha.appendChild(topo);

  const titulo = document.createElement("p");
  titulo.className = "ficha-chat-mensagem-titulo";
  titulo.textContent = ev.titulo;
  bolha.appendChild(titulo);

  if (ev.descricao) {
    const desc = document.createElement("p");
    desc.className = "ficha-chat-mensagem-descricao";
    desc.textContent = ev.descricao;
    bolha.appendChild(desc);
  }

  if (ev.responsavel) {
    const resp = document.createElement("p");
    resp.className = "ficha-chat-mensagem-responsavel";
    resp.textContent = `— ${ev.responsavel}`;
    bolha.appendChild(resp);
  }

  return bolha;
}

// Linha do rail (bolinha + linha vertical contínua) + o cartão da mensagem —
// é o "item" que entra na lista do chat (a linha conecta visualmente um item
// ao próximo via CSS, ver .ficha-chat-rail::before).
function construirFichaChatItem(ev) {
  const item = document.createElement("div");
  item.className = "ficha-chat-item";

  const rail = document.createElement("div");
  rail.className = "ficha-chat-rail";
  const ponto = document.createElement("span");
  ponto.className = "ficha-chat-rail-ponto";
  ponto.style.backgroundColor = corFichaChatEvento(ev);
  rail.appendChild(ponto);
  item.appendChild(rail);

  item.appendChild(construirFichaChatMensagem(ev));
  return item;
}

function construirFichaChatDivisorData(dataIso) {
  const divisor = document.createElement("div");
  divisor.className = "ficha-chat-divisor";
  const span = document.createElement("span");
  span.textContent = formatarDataBRSimples(dataIso) || "Sem data";
  divisor.appendChild(span);
  return divisor;
}

// Rola pro final só depois do nó estar de verdade no documento (scrollHeight
// de um elemento ainda desconectado vem zerado) — por isso o rAF, tanto na
// primeira montagem quanto depois de registrar um acontecimento novo.
function renderFichaChat(container, eventos) {
  container.innerHTML = "";
  if (!eventos.length) {
    container.appendChild(construirFichaHistoricoVazio(
      "Nenhum acontecimento ainda",
      "Use o campo abaixo pra registrar o primeiro — ele entra direto na conversa."
    ));
    return;
  }
  // Mensagens do mesmo dia ficam juntas sob um só divisor de data (igual
  // chat de verdade) — cada mensagem individual não repete mais a data.
  let dataAnterior = null;
  eventos.forEach((ev) => {
    const dataDoEvento = ev.data || "";
    if (dataDoEvento !== dataAnterior) {
      container.appendChild(construirFichaChatDivisorData(dataDoEvento));
      dataAnterior = dataDoEvento;
    }
    container.appendChild(construirFichaChatItem(ev));
  });
  requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
}

async function carregarFichaDetalhadoChat(implantacao, forcarRecarga, card) {
  const chatEl = card._fichaChatLista;
  chatEl.innerHTML = '<p class="placeholder">Carregando...</p>';
  try {
    const eventosReais = await obterFichaTimelineEventos(implantacao.id, forcarRecarga);
    const migracoes = (fichaClienteAtual && fichaClienteAtual.migracoes) || [];
    renderFichaChat(chatEl, montarFichaChatEventos(eventosReais, migracoes));
  } catch (err) {
    mostrarErroEmNode(chatEl, String(err));
  }
}

// --- Modal "Novo acontecimento" do chat (aba Detalhado) ---
// Antes era um formulário sempre visível embaixo do chat — comia espaço de
// tela e sobrava pouca área pra ler as mensagens. Agora é só um botão; o
// formulário mora num modal próprio (overlay-ficha-chat-evento), reaproveitando
// os mesmos campos (Setor aqui É um campo, diferente do modal de Implantação/
// Marcos onde o setor já vem de qual "+" foi clicado).
const overlayFichaChatEvento = el("overlay-ficha-chat-evento");
const formFichaChatEvento = el("form-ficha-chat-evento");
const inputFichaChatEventoTitulo = el("ficha-chat-evento-titulo");
const selectFichaChatEventoSetor = el("ficha-chat-evento-setor");
const selectFichaChatEventoTag = el("ficha-chat-evento-tag");
const inputFichaChatEventoData = el("ficha-chat-evento-data");
const inputFichaChatEventoResponsavel = el("ficha-chat-evento-responsavel");
const textareaFichaChatEventoDescricao = el("ficha-chat-evento-descricao");
const btnSalvarFichaChatEvento = el("btn-salvar-ficha-chat-evento");
let fichaChatEventoImplantacaoAtual = null;

function abrirModalFichaChatEvento(implantacao) {
  fichaChatEventoImplantacaoAtual = implantacao;
  formFichaChatEvento.reset();
  inputFichaChatEventoData.value = new Date().toISOString().slice(0, 10);
  overlayFichaChatEvento.classList.remove("hidden");
  inputFichaChatEventoTitulo.focus();
}

el("ficha-chat-evento-modal-fechar").addEventListener("click", () => overlayFichaChatEvento.classList.add("hidden"));

formFichaChatEvento.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!fichaChatEventoImplantacaoAtual) return;
  const payload = {
    setor: selectFichaChatEventoSetor.value,
    titulo: inputFichaChatEventoTitulo.value.trim(),
    tag: selectFichaChatEventoTag.value,
    descricao: textareaFichaChatEventoDescricao.value.trim(),
    data: inputFichaChatEventoData.value,
    responsavel: inputFichaChatEventoResponsavel.value.trim(),
  };
  if (!payload.titulo) return;
  btnSalvarFichaChatEvento.disabled = true;
  try {
    const r = await fetch(`/api/clientes/${fichaChatEventoImplantacaoAtual.id}/eventos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao registrar: ${data.error || "falha desconhecida"}`);
    // Cache da Timeline fica desatualizada com o evento novo — força
    // recarregar na próxima vez que qualquer uma das duas abas for aberta.
    fichaTimelineClienteIdCache = null;
    overlayFichaChatEvento.classList.add("hidden");
    if (fichaHistoricoAreaAtual === "detalhado" || fichaHistoricoAreaAtual === "timeline") mostrarFichaAba("historico");
  } catch (err) {
    alert(`Erro ao registrar: ${String(err)}`);
  } finally {
    btnSalvarFichaChatEvento.disabled = false;
  }
});

function construirFichaDetalhadoChat(implantacao) {
  const card = document.createElement("div");
  card.className = "ficha-painel ficha-detalhado-card";

  if (!implantacao) {
    card.appendChild(construirFichaHistoricoVazio(
      "Sem Implantação",
      "Esse cliente não tem Implantação — não há histórico detalhado pra mostrar."
    ));
    return card;
  }

  const chat = document.createElement("div");
  chat.className = "ficha-chat-lista";
  card.appendChild(chat);
  card._fichaChatLista = chat;

  const btnNovoEvento = document.createElement("button");
  btnNovoEvento.type = "button";
  btnNovoEvento.className = "btn-primary ficha-chat-btn-novo";
  btnNovoEvento.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span>Adicionar acontecimento</span>';
  btnNovoEvento.addEventListener("click", () => abrirModalFichaChatEvento(implantacao));
  card.appendChild(btnNovoEvento);

  if (fichaTimelineClienteIdCache === implantacao.id) {
    const migracoes = (fichaClienteAtual && fichaClienteAtual.migracoes) || [];
    renderFichaChat(chat, montarFichaChatEventos(fichaTimelineEventosCache, migracoes));
  } else {
    chat.innerHTML = '<p class="placeholder">Carregando...</p>';
    carregarFichaDetalhadoChat(implantacao, false, card);
  }

  return card;
}

// Abas por área dentro da aba Histórico do sidebar — "Timeline" (padrão ao
// abrir) é o atalho pra linha do tempo de Implantação, "Detalhado" é o
// conteúdo que antes se chamava "Geral" (tentativas de migração). As áreas
// CS/Treinamento/Suporte/Comercial ainda não têm uma fonte de registros
// associada a elas; ficam com um placeholder até existir o que filtrar.
const FICHA_HISTORICO_AREAS = [
  ["timeline", "Timeline"],
  ["detalhado", "Detalhado"],
  ["cs", "CS"],
  ["treinamento", "Treinamento"],
  ["suporte", "Suporte"],
  ["comercial", "Comercial"],
];
let fichaHistoricoAreaAtual = "timeline";

function construirFichaHistoricoAbas(ativa) {
  const nav = document.createElement("div");
  nav.className = "ficha-subabas";
  nav.setAttribute("role", "tablist");
  FICHA_HISTORICO_AREAS.forEach(([chave, rotulo]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ficha-subaba" + (chave === ativa ? " ativo" : "");
    btn.textContent = rotulo;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(chave === ativa));
    btn.addEventListener("click", () => {
      if (chave === fichaHistoricoAreaAtual) return;
      fichaHistoricoAreaAtual = chave;
      mostrarFichaAba("historico");
    });
    nav.appendChild(btn);
  });
  return nav;
}

function construirFichaHistorico(implantacao, migracao) {
  const wrap = document.createElement("div");
  wrap.className = "ficha-historico-wrap";
  wrap.appendChild(construirFichaHistoricoAbas(fichaHistoricoAreaAtual));

  if (fichaHistoricoAreaAtual === "timeline") {
    wrap.appendChild(construirFichaTimelineCard(implantacao));
  } else if (fichaHistoricoAreaAtual === "detalhado") {
    wrap.appendChild(construirFichaDetalhadoChat(implantacao));
  } else {
    const nomeArea = (FICHA_HISTORICO_AREAS.find(([chave]) => chave === fichaHistoricoAreaAtual) || [])[1] || "";
    const card = document.createElement("div");
    card.className = "ficha-painel";
    card.appendChild(construirFichaHistoricoVazio(
      "Nada por aqui ainda",
      `Essa área (${nomeArea}) ainda não tem uma fonte de registros associada a ela.`
    ));
    wrap.appendChild(card);
  }
  return wrap;
}

function construirFichaVisaoGeral(idcentral, implantacao, migracao, credencialConfigurada, credencialLogin, subAba = "geral") {
  const wrap = document.createElement("div");
  wrap.appendChild(construirFichaSubAbas(subAba));

  if (subAba === "informacoes") {
    if (implantacao) wrap.appendChild(construirFichaLinhaContato(implantacao));
    wrap.appendChild(construirFichaResumoCard(implantacao, migracao));
    wrap.appendChild(construirFichaOperacionalCard(idcentral, implantacao, credencialConfigurada, credencialLogin));
    return wrap;
  }
  if (subAba === "progresso") {
    const progresso = construirFichaProgressoCard(implantacao, migracao);
    if (progresso) {
      wrap.appendChild(progresso);
    } else {
      const p = document.createElement("p");
      p.className = "placeholder";
      p.textContent = "Sem progresso para mostrar.";
      wrap.appendChild(p);
    }
    return wrap;
  }

  // Tags hierárquicas + linha de contato — pra bater o olho na Visão Geral e
  // já entender a situação do cliente, sem precisar abrir Configuração/Editar
  // Cliente. "Marco atual" não vira tag aqui: o card de Progresso já mostra
  // isso com muito mais clareza (stepper), então repetir seria peso duplicado.
  if (implantacao) {
    // Tags (Implantado/Momento/Persona/Flag/Atrasado) são todas da jornada de
    // Implantação — não fazem sentido pra um cliente que só tem Migração.
    if (implantacao.tem_implantacao !== false) {
      const tags = document.createElement("div");
      tags.className = "ficha-tags-resumo";
      if (implantacao.implantado) tags.appendChild(criarTagResumo("Implantado", "tag-implantado"));
      if (implantacao.momento) tags.appendChild(criarTagResumo(implantacao.momento, "tag-momento"));
      if (implantacao.persona) tags.appendChild(criarTagResumo(implantacao.persona, "tag-persona"));
      if (implantacao.flag) {
        const tagFlag = criarTagResumo(implantacao.flag, classeFlagTag(implantacao.flag));
        tagFlag.insertAdjacentHTML("afterbegin", '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>');
        tags.appendChild(tagFlag);
      }
      if (implantacaoAtrasada(implantacao)) tags.appendChild(criarTagResumo("Atrasado", "tag-flag-red"));
      if (tags.children.length) wrap.appendChild(tags);
    }

    wrap.appendChild(construirFichaLinhaContato(implantacao));
  }

  // Atenção/Pendências — concentra tudo que precisa de ação num só lugar, em
  // vez de espalhado pela tela.
  wrap.appendChild(construirFichaAlertasCard(implantacao, migracao));

  // Resumo do cliente + Tarefas lado a lado — bloco principal de
  // acompanhamento do cliente.
  const grid = document.createElement("div");
  grid.className = "ficha-grid-hub";
  grid.appendChild(construirFichaResumoCard(implantacao, migracao));
  if (implantacao) {
    grid.appendChild(construirFichaTarefasPainel(implantacao));
  } else {
    grid.classList.add("ficha-grid-hub-unica");
  }
  wrap.appendChild(grid);

  const progresso = construirFichaProgressoCard(implantacao, migracao);
  if (progresso) wrap.appendChild(progresso);

  wrap.appendChild(construirFichaOperacionalCard(idcentral, implantacao, credencialConfigurada, credencialLogin));

  return wrap;
}

function construirFichaImplantacao(implantacao, migracao) {
  const wrap = document.createElement("div");

  if (!implantacao) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Esse cliente não tem registro em Implantação.";
    wrap.appendChild(p);
    return wrap;
  }

  const sec = document.createElement("div");
  sec.className = "ficha-secao";
  const grid = document.createElement("div");
  grid.className = "info-grid";
  grid.appendChild(criarInfoItem("IdCentral", implantacao.idcentral));
  grid.appendChild(criarInfoItem("Etapa", implantacao.etapa === "concluido"
    ? IMPLANTACAO_ETAPA_LABELS.concluido : nomeCompletoMarco(implantacao.etapa)));
  grid.appendChild(criarInfoItem("Implantado", implantacao.implantado
    ? `Sim${implantacao.implantado_em ? `, desde ${formatarDataBRSimples(implantacao.implantado_em)}` : ""}` : "Não"));
  grid.appendChild(criarInfoItem("Responsável", implantacao.csm));
  grid.appendChild(criarInfoItem("Última ação", implantacao.ultima_acao));
  sec.appendChild(grid);

  const acoes = document.createElement("div");
  acoes.className = "ficha-acoes";
  const btn = document.createElement("button");
  btn.className = "btn-secondary";
  btn.textContent = "Ver linha do tempo completa";
  btn.addEventListener("click", () => abrirTimelineImplantacao(implantacao));
  acoes.appendChild(btn);

  const btnEmail = document.createElement("button");
  btnEmail.className = "btn-secondary";
  btnEmail.textContent = "Gerar e-mail de boas-vindas";
  btnEmail.addEventListener("click", () => abrirEmailBoasVindas());
  acoes.appendChild(btnEmail);
  sec.appendChild(acoes);

  wrap.appendChild(sec);
  return wrap;
}

// E-mail de boas-vindas. Texto padrão da Systemsat com os dados de acesso do
// cliente preenchidos. Enquanto o e-mail do cliente não é informado no modal,
// aparece o marcador EMAIL DO CLIENTE pra não sair em branco por engano.
const EMAIL_BOAS_VINDAS_MARCADOR_EMAIL = "EMAIL DO CLIENTE";

function montarEmailBoasVindas(emailCliente, nomeUsuario) {
  const email = emailCliente || EMAIL_BOAS_VINDAS_MARCADOR_EMAIL;
  const assinante = nomeUsuario || "NOME DO USUARIO";

  const paragrafos = [
    "Sejam bem-vindos à Systemsat.",
    "Em nome de toda a nossa equipe, queremos expressar a satisfação em tê-los como parceiros. Estamos animados para embarcar nessa jornada conjunta e confiantes de que essa parceria será um passo importante para alcançarmos excelentes resultados.",
    [
      "Informações de acesso ao SSX:",
      "Acesse a plataforma:",
      `LOGIN: ${email}`,
      "SENHA: admin",
    ].join("\n"),
    [
      "Material de apoio ao uso:",
      "Pensando em proporcionar uma experiência fluida desde o início, disponibilizamos a nossa universidade online — um ambiente completo de aprendizado, desenvolvido para apoiar cada etapa da sua operação dentro da plataforma SSX.",
      "Lá, vocês terão acesso a trilhas de treinamento estruturadas, conteúdos práticos, vídeos explicativos e boas práticas de mercado, tudo organizado para acelerar a adoção da plataforma e potencializar os resultados da operação.",
    ].join("\n\n"),
    [
      "Informações de acesso à universidade:",
      "Link: https://universidadesystemsat.com.br/login",
      `E-mail: ${email}`,
      "Senha provisória: 123456",
    ].join("\n"),
    "Recomendamos que a equipe explore os conteúdos desde o início — isso fará toda a diferença na autonomia e performance ao longo da jornada.",
    "Conte conosco ao longo desse caminho. Estamos à disposição para apoiar no que for necessário para o sucesso da operação.",
    [
      "Atenciosamente,",
      assinante,
      "Sucesso do Cliente",
    ].join("\n"),
  ];
  return {
    assunto: "Sejam bem-vindos à Systemsat!",
    corpo: paragrafos.join("\n\n"),
  };
}

const overlayEmailBoasVindas = el("overlay-email-boas-vindas");
const inputEmailBoasVindasEmailCliente = el("email-boas-vindas-email-cliente");
const inputEmailBoasVindasAssunto = el("email-boas-vindas-assunto");
const inputEmailBoasVindasCorpo = el("email-boas-vindas-corpo");
const btnEmailBoasVindasCopiar = el("btn-email-boas-vindas-copiar");

function abrirEmailBoasVindas() {
  // O nome de quem está logado é o Responsável (CS) ligado ao login — o mesmo
  // que o servidor já guarda na sessão e expõe no body da página.
  const { assunto, corpo } = montarEmailBoasVindas("", document.body.dataset.usuarioResponsavel || "");
  inputEmailBoasVindasEmailCliente.value = "";
  inputEmailBoasVindasAssunto.value = assunto;
  inputEmailBoasVindasCorpo.value = corpo;
  btnEmailBoasVindasCopiar.textContent = "Copiar";
  overlayEmailBoasVindas.classList.remove("hidden");
  inputEmailBoasVindasEmailCliente.focus();
}

// Troca só as linhas "LOGIN:" e "E-mail:" (com âncora de linha), em vez de gerar
// o texto de novo — assim o resto do que a pessoa já editou na mensagem não se perde.
inputEmailBoasVindasEmailCliente.addEventListener("input", () => {
  const novo = inputEmailBoasVindasEmailCliente.value.trim() || EMAIL_BOAS_VINDAS_MARCADOR_EMAIL;
  inputEmailBoasVindasCorpo.value = inputEmailBoasVindasCorpo.value
    .replace(/^LOGIN: .*$/m, `LOGIN: ${novo}`)
    .replace(/^E-mail: .*$/m, `E-mail: ${novo}`);
});

el("email-boas-vindas-modal-fechar").addEventListener("click", () => overlayEmailBoasVindas.classList.add("hidden"));

btnEmailBoasVindasCopiar.addEventListener("click", async () => {
  const texto = `Assunto: ${inputEmailBoasVindasAssunto.value}\n\n${inputEmailBoasVindasCorpo.value}`;
  try {
    await navigator.clipboard.writeText(texto);
    btnEmailBoasVindasCopiar.textContent = "Copiado ✓";
    setTimeout(() => { btnEmailBoasVindasCopiar.textContent = "Copiar"; }, 1500);
  } catch (err) {
    alert(`Não foi possível copiar: ${String(err)}`);
  }
});

// Linha de acesso rápido (login/senha da plataforma de origem) com botão de
// copiar e, pra senha, um "olhinho" (👁) pra revelar antes de copiar — ela
// nasce mascarada (••••••••), igual ao padrão já usado na lista de logins
// salvos da tela de entrada (spanSenha em renderListaCredenciais).
function criarLinhaAcessoCopiavel(label, valor, mascarar) {
  const linha = document.createElement("div");
  linha.className = "acesso-origem-linha";

  const lbl = document.createElement("span");
  lbl.className = "acesso-origem-label";
  lbl.textContent = label;
  linha.appendChild(lbl);

  const span = document.createElement("span");
  span.className = "acesso-origem-valor";
  let revelado = !mascarar;
  const renderizar = () => { span.textContent = valor ? (revelado ? valor : "••••••••") : "-"; };
  renderizar();
  linha.appendChild(span);

  if (mascarar && valor) {
    const btnOlho = document.createElement("button");
    btnOlho.type = "button";
    btnOlho.className = "acesso-origem-botao";
    btnOlho.title = "Mostrar/ocultar";
    btnOlho.textContent = "👁";
    btnOlho.addEventListener("click", () => {
      revelado = !revelado;
      renderizar();
    });
    linha.appendChild(btnOlho);
  }

  if (valor) {
    const btnCopiar = document.createElement("button");
    btnCopiar.type = "button";
    btnCopiar.className = "acesso-origem-botao";
    btnCopiar.title = "Copiar";
    btnCopiar.textContent = "📋";
    btnCopiar.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(valor);
        btnCopiar.textContent = "✓";
        setTimeout(() => { btnCopiar.textContent = "📋"; }, 1200);
      } catch (err) {
        alert(`Não foi possível copiar: ${String(err)}`);
      }
    });
    linha.appendChild(btnCopiar);
  }

  return linha;
}

// Card de acesso rápido à plataforma de origem — o cliente costuma passar
// link/login/senha de lá pra gente exportar os dados dele na migração.
function construirCardAcessoOrigem(migracao) {
  const card = document.createElement("div");
  card.className = "acesso-origem-card";

  const cabecalho = document.createElement("div");
  cabecalho.className = "acesso-origem-cabecalho";
  const titulo = document.createElement("h3");
  titulo.textContent = "Acesso à plataforma de origem";
  cabecalho.appendChild(titulo);
  if (migracao.link_acesso_origem) {
    const btnAbrir = document.createElement("button");
    btnAbrir.type = "button";
    btnAbrir.className = "acesso-origem-abrir";
    btnAbrir.textContent = "Abrir ↗";
    btnAbrir.addEventListener("click", () => window.open(migracao.link_acesso_origem, "_blank", "noopener"));
    cabecalho.appendChild(btnAbrir);
  }
  card.appendChild(cabecalho);

  if (!migracao.link_acesso_origem && !migracao.login_acesso_origem && !migracao.senha_acesso_origem) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nenhum acesso cadastrado ainda.";
    card.appendChild(p);
    return card;
  }

  const corpo = document.createElement("div");
  corpo.className = "acesso-origem-corpo";
  corpo.appendChild(criarLinhaAcessoCopiavel("Login", migracao.login_acesso_origem, false));
  corpo.appendChild(criarLinhaAcessoCopiavel("Senha", migracao.senha_acesso_origem, true));
  card.appendChild(corpo);

  return card;
}

// Tabela "Modelo | % | Aguardando | Enviar | Enviado | Comunicou | Total" —
// valores já calculados na aba "Infos gerais" da planilha (fórmulas de lá),
// só lidos e exibidos aqui depois de "Importar da planilha". Sem textContent
// com dado de planilha em innerHTML — evita XSS se alguém digitar algo
// esquisito numa célula "Modelo".
function renderResumoModelos(container, resumo) {
  container.innerHTML = "";
  if (!resumo || !resumo.length) return;
  const titulo = document.createElement("h4");
  titulo.className = "form-credencial-titulo";
  titulo.textContent = "Resumo por modelo (da planilha)";
  container.appendChild(titulo);
  const table = document.createElement("table");
  table.className = "tabela-credenciais";
  const thead = document.createElement("thead");
  const trCab = document.createElement("tr");
  ["Modelo", "%", "Aguardando", "Enviar", "Enviado", "Comunicou", "Total"].forEach((rotulo) => {
    const th = document.createElement("th");
    th.textContent = rotulo;
    trCab.appendChild(th);
  });
  thead.appendChild(trCab);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  resumo.forEach((linha) => {
    const tr = document.createElement("tr");
    ["modelo", "percentual", "aguardando", "enviar", "enviado", "comunicou", "total"].forEach((campo) => {
      const td = document.createElement("td");
      td.textContent = linha[campo] || "";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

function construirFichaMigracao(implantacao, migracao, migracoes) {
  const wrap = document.createElement("div");

  if (!migracao) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Esse cliente ainda não tem nenhum processo de migração registrado. "
      + 'Marque "Tem Migração? Sim" no cadastro do cliente pra iniciar um.';
    wrap.appendChild(p);
    return wrap;
  }

  const sec = document.createElement("div");
  sec.className = "ficha-secao";
  const grid = document.createElement("div");
  grid.className = "info-grid";
  // Dias em migração: enquanto está rodando, conta até hoje; depois de
  // concluída/cancelada, fica fixo na duração real do processo (início → fim).
  const diasMigracao = migracao.data_fim
    ? diasEntre(migracao.data_inicio, migracao.data_fim)
    : diasDesdeEntrada(migracao.data_inicio);
  grid.appendChild(criarInfoItem("Status", MIGRACAO_STATUS_LABELS[migracao.status] || migracao.status));
  grid.appendChild(criarInfoItem("Etapa", MIGRACAO_ETAPA_LABELS[migracao.etapa] || migracao.etapa));
  grid.appendChild(criarInfoItem("Plataforma de origem", migracao.plataforma_origem));
  // Referência guardada pra "Importar da planilha" atualizar o número na
  // hora (percentual_migracao é recalculado a cada importação — ver abaixo).
  const itemProgressoMigracao = criarInfoItem("Progresso da migração", `${migracao.percentual_migracao || 0}%`);
  grid.appendChild(itemProgressoMigracao);
  grid.appendChild(criarInfoItem(
    "Dias em migração",
    diasMigracao === null ? "-" : `${diasMigracao} dia${diasMigracao === 1 ? "" : "s"}`
  ));
  grid.appendChild(criarInfoItem("Início", migracao.data_inicio));
  if (migracao.data_fim) grid.appendChild(criarInfoItem("Fim", migracao.data_fim));
  sec.appendChild(grid);

  const acoes = document.createElement("div");
  acoes.className = "ficha-acoes";
  const btn = document.createElement("button");
  btn.className = "btn-secondary";
  btn.textContent = "Ver veículos";
  btn.addEventListener("click", () => abrirVeiculosCliente(implantacao.id, migracao.id, implantacao.cliente));
  acoes.appendChild(btn);

  const btnPlanilha = document.createElement("button");
  btnPlanilha.className = "btn-secondary";
  btnPlanilha.textContent = "Planilha de Migração";
  btnPlanilha.addEventListener("click", () => {
    if (!migracao.link_planilha) {
      return alert("Nenhum link cadastrado ainda. Configure no cadastro do cliente.");
    }
    window.open(migracao.link_planilha, "_blank", "noopener");
  });
  acoes.appendChild(btnPlanilha);

  if (migracao.link_planilha) {
    const btnImportar = document.createElement("button");
    btnImportar.className = "btn-secondary";
    btnImportar.textContent = "Importar da planilha";
    btnImportar.title = "Lê a aba \"Migração\" da planilha e atualiza os veículos aqui (cliente+veículo repetido só atualiza, não duplica).";
    btnImportar.addEventListener("click", async () => {
      const textoOriginal = btnImportar.textContent;
      btnImportar.disabled = true;
      btnImportar.textContent = "Importando...";
      try {
        const r = await fetch(`/api/clientes/${implantacao.id}/migracoes/${migracao.id}/importar-planilha`, { method: "POST" });
        const data = await parseJsonResponse(r);
        if (!data.ok) return alert(`Erro ao importar: ${data.error || "falha desconhecida"}`);
        alert(`Importação concluída: ${data.importados} veículo(s) (${data.qtd_clientes} cliente(s), ${data.qtd_placas} placa(s)).`);
        renderResumoModelos(resumoModelosDiv, data.resumo_modelos);
        const valorProgresso = itemProgressoMigracao.querySelector(".info-item-valor");
        if (valorProgresso && data.percentual_migracao !== undefined) {
          valorProgresso.textContent = `${data.percentual_migracao}%`;
        }
      } catch (err) {
        alert(`Erro ao importar: ${String(err)}`);
      } finally {
        btnImportar.disabled = false;
        btnImportar.textContent = textoOriginal;
      }
    });
    acoes.appendChild(btnImportar);
  }

  // Finalizar/Cancelar só existem aqui (Ficha > Migração) — de propósito: o
  // cadastro do cliente trava o campo assim que a migração está em
  // andamento, então essa é a única forma de tirar uma migração do ar (não
  // dá pra só "excluir").
  if (migracao.status === "em_andamento") {
    const btnFinalizar = document.createElement("button");
    btnFinalizar.className = "btn-secondary";
    btnFinalizar.textContent = "Finalizar migração";
    btnFinalizar.addEventListener("click", async () => {
      if (!confirm(`Finalizar a migração de "${implantacao.cliente}"? Marca o processo como concluído e move a planilha (se tiver) pra pasta "Finalizadas" no Drive.`)) return;
      try {
        const r = await fetch(`/api/clientes/${implantacao.id}/migracoes/${migracao.id}/finalizar`, { method: "POST" });
        const data = await parseJsonResponse(r);
        if (!data.ok) return alert(`Erro ao finalizar: ${data.error || "falha desconhecida"}`);
        if (data.aviso) alert(data.aviso);
        const rf = await fetch(`/api/ficha/${encodeURIComponent(implantacao.idcentral)}`);
        const dataFicha = await parseJsonResponse(rf);
        if (dataFicha.ok) {
          fichaClienteAtual = dataFicha;
          el("ficha-aba-migracao").classList.toggle("hidden", !dataFicha.migracao);
          mostrarFichaAba("migracao");
        }
      } catch (err) {
        alert(`Erro ao finalizar: ${String(err)}`);
      }
    });
    acoes.appendChild(btnFinalizar);

    const btnCancelar = document.createElement("button");
    btnCancelar.className = "btn-secondary";
    btnCancelar.textContent = "Cancelar migração";
    btnCancelar.addEventListener("click", async () => {
      if (!confirm(`Cancelar a migração de "${implantacao.cliente}"? Isso não exclui os veículos já cadastrados, só marca esse processo como cancelado.`)) return;
      const motivo = prompt("Motivo do cancelamento (opcional):", "") || "";
      try {
        const r = await fetch(`/api/clientes/${implantacao.id}/migracoes/${migracao.id}/cancelar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ motivo }),
        });
        const data = await parseJsonResponse(r);
        if (!data.ok) return alert(`Erro ao cancelar: ${data.error || "falha desconhecida"}`);
        const rf = await fetch(`/api/ficha/${encodeURIComponent(implantacao.idcentral)}`);
        const dataFicha = await parseJsonResponse(rf);
        if (dataFicha.ok) {
          fichaClienteAtual = dataFicha;
          el("ficha-aba-migracao").classList.toggle("hidden", !dataFicha.migracao);
          mostrarFichaAba("migracao");
        }
      } catch (err) {
        alert(`Erro ao cancelar: ${String(err)}`);
      }
    });
    acoes.appendChild(btnCancelar);
  }

  sec.appendChild(acoes);

  // Tabela de fórmulas já calculadas na própria planilha (aba "Infos
  // gerais"), só exibida aqui, nunca recalculada pelo sistema. Preenchida
  // de dois jeitos: automático (busca "ao vivo" só-leitura toda vez que essa
  // aba abre, logo abaixo) e manual, via "Importar da planilha" acima (que
  // além de atualizar isso também grava os veículos no sistema).
  const resumoModelosDiv = document.createElement("div");
  resumoModelosDiv.className = "resumo-modelos-planilha";
  sec.appendChild(resumoModelosDiv);

  if (migracao.link_planilha) {
    fetch(`/api/clientes/${implantacao.id}/migracoes/${migracao.id}/resumo-planilha`)
      .then(parseJsonResponse)
      .then((data) => {
        if (!data.ok) return; // planilha instável/sem permissão nesse momento — não interrompe a Ficha
        renderResumoModelos(resumoModelosDiv, data.resumo_modelos);
        if (data.percentual_migracao !== null && data.percentual_migracao !== undefined) {
          const valorProgresso = itemProgressoMigracao.querySelector(".info-item-valor");
          if (valorProgresso) valorProgresso.textContent = `${data.percentual_migracao}%`;
        }
      })
      .catch(() => {}); // idem — falha silenciosa, é só um "a mais", a Ficha já carregou normalmente
  }

  wrap.appendChild(sec);
  wrap.appendChild(construirCardAcessoOrigem(migracao));

  // Histórico de tentativas anteriores (a atual/mais recente já aparece acima).
  const anteriores = (migracoes || []).filter((m) => m.id !== migracao.id);
  if (anteriores.length > 0) {
    const historico = document.createElement("div");
    historico.className = "ficha-secao";
    const h = document.createElement("h4");
    h.className = "form-credencial-titulo";
    h.textContent = "Processos anteriores";
    historico.appendChild(h);
    anteriores.forEach((m) => {
      const linha = document.createElement("p");
      linha.className = "placeholder";
      const periodo = m.data_fim ? `${m.data_inicio} — ${m.data_fim}` : `desde ${m.data_inicio}`;
      const motivo = m.motivo ? ` — ${m.motivo}` : "";
      linha.textContent = `${MIGRACAO_STATUS_LABELS[m.status] || m.status} (${periodo})${motivo}`;
      historico.appendChild(linha);
    });
    wrap.appendChild(historico);
  }

  return wrap;
}

function mostrarFichaAba(aba) {
  fichaAbaAtual = aba;
  el("ficha-aba-geral").classList.toggle("ativo", aba === "geral");
  el("ficha-aba-implantacao").classList.toggle("ativo", aba === "implantacao");
  el("ficha-aba-marcos").classList.toggle("ativo", aba === "marcos");
  el("ficha-aba-migracao").classList.toggle("ativo", aba === "migracao");
  el("ficha-aba-historico").classList.toggle("ativo", aba === "historico");

  const corpo = el("ficha-cliente-corpo");
  corpo.innerHTML = "";
  // Só a sub-aba Detalhado (chat de acontecimentos) precisa travar a altura
  // do painel na tela toda — as outras abas continuam rolando a página
  // normalmente. Ver regras em "Aba Detalhado (Histórico)" no style.css.
  el("tela-ficha-cliente").classList.toggle("ficha-historico-detalhado-ativo", aba === "historico" && fichaHistoricoAreaAtual === "detalhado");
  if (!fichaClienteAtual) return;
  const { idcentral, implantacao, migracao, migracoes, credencial_configurada, credencial_login } = fichaClienteAtual;
  if (aba === "geral") corpo.appendChild(construirFichaVisaoGeral(idcentral, implantacao, migracao, credencial_configurada, credencial_login, fichaSubAbaAtual));
  if (aba === "implantacao") corpo.appendChild(construirFichaImplantacao(implantacao, migracao));
  if (aba === "marcos") corpo.appendChild(construirFichaMarcos(implantacao, migracao));
  if (aba === "migracao") corpo.appendChild(construirFichaMigracao(implantacao, migracao, migracoes));
  if (aba === "historico") corpo.appendChild(construirFichaHistorico(implantacao, migracao));
}

async function carregarFichaCliente(idcentral, aba = "geral") {
  fichaClienteAtual = null;
  el("ficha-sidebar-nome").textContent = "Carregando...";
  const cabecalho = el("ficha-cliente-cabecalho");
  cabecalho.innerHTML = "";
  const corpo = el("ficha-cliente-corpo");
  corpo.innerHTML = '<p class="placeholder">Carregando...</p>';
  try {
    const r = await fetch(`/api/ficha/${encodeURIComponent(idcentral)}`);
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      el("ficha-sidebar-nome").textContent = "Não encontrado";
      el("ficha-aba-migracao").classList.add("hidden");
      mostrarErroEmNode(corpo, data.error || "Cliente não encontrado.");
      return;
    }
    fichaClienteAtual = data;
    const nome = (data.implantacao && data.implantacao.cliente) || (data.migracao && data.migracao.nome) || idcentral;
    el("ficha-sidebar-nome").textContent = nome;
    // Nome do cliente + engrenagem fica fora do conteúdo que troca a cada aba
    // (não é mais reconstruído em toda mostrarFichaAba) — menos repetição,
    // menos espaço de título ocupado em cada aba.
    cabecalho.innerHTML = "";
    cabecalho.appendChild(construirFichaHeader(data.implantacao, data.migracao, true));
    el("ficha-aba-migracao").classList.toggle("hidden", !data.migracao);
    // Cliente criado pela tela de Migração sem par na Implantação
    // (tem_implantacao=false) tem menu enxuto: só Visão Geral, Migração e
    // Histórico — sem Implantação/Marcos, que não existem pra ele.
    const semImplantacao = data.implantacao && data.implantacao.tem_implantacao === false;
    el("ficha-aba-implantacao").classList.toggle("hidden", semImplantacao);
    el("ficha-aba-marcos").classList.toggle("hidden", semImplantacao);
    const abasEscondidas = semImplantacao ? ["implantacao", "marcos"] : [];
    const abaFinal = (aba === "migracao" && !data.migracao) || abasEscondidas.includes(aba) ? "geral" : aba;
    mostrarFichaAba(abaFinal);
  } catch (err) {
    mostrarErroEmNode(corpo, String(err));
  }
}

// --- CREDENCIAL SSX DA FICHA (edição, admin-only) ---
const overlayFichaCredencial = el("overlay-ficha-credencial");
const modalFichaCredencialEl = el("modal-ficha-credencial");
const credencialSidebarConfig = el("credencial-sidebar-config");
const formFichaCredencial = el("form-ficha-credencial");
const inputFichaCredencialLogin = el("ficha-credencial-login");
const inputFichaCredencialSenha = el("ficha-credencial-senha");
let fichaCredencialIdcentralAtual = null;

function abrirModalFichaCredencial(idcentral, loginAtual) {
  // Sidebar só aparece quando aberto pela engrenagem da Ficha (mostrarConfigFichaAba
  // chama ativarSidebarConfig logo depois) — nos atalhos diretos (Consulta,
  // Importação, Visão Geral) fica escondida, igual aos outros 2 modais de config.
  credencialSidebarConfig.classList.add("hidden");
  modalFichaCredencialEl.classList.remove("tem-sidebar-config");
  fichaCredencialIdcentralAtual = idcentral;
  inputFichaCredencialLogin.value = loginAtual || "";
  inputFichaCredencialSenha.value = "";
  overlayFichaCredencial.classList.remove("hidden");
  inputFichaCredencialLogin.focus();
}

el("ficha-credencial-modal-fechar").addEventListener("click", () => {
  overlayFichaCredencial.classList.add("hidden");
  fichaConfigContexto = null;
});
credencialSidebarConfig.querySelectorAll(".modal-sidebar-config-item").forEach((btn) => {
  btn.addEventListener("click", () => mostrarConfigFichaAba(btn.dataset.aba));
});

formFichaCredencial.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!fichaCredencialIdcentralAtual) return;
  const payload = {
    login: inputFichaCredencialLogin.value.trim(),
    senha: inputFichaCredencialSenha.value,
  };
  try {
    const r = await fetch(`/api/ficha/${encodeURIComponent(fichaCredencialIdcentralAtual)}/credencial`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao salvar: ${data.error || "falha desconhecida"}`);
    overlayFichaCredencial.classList.add("hidden");
    fichaConfigContexto = null;
    await carregarFichaCliente(fichaCredencialIdcentralAtual);
  } catch (err) {
    alert(`Erro ao salvar: ${String(err)}`);
  }
});

irParaTela(resolverCaminho(window.location.pathname).tela, {
  semHistorico: true,
  idcentral: resolverCaminho(window.location.pathname).idcentral,
  sub: resolverCaminho(window.location.pathname).sub,
});

atualizarStatus();
