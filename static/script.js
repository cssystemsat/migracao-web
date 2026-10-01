const el = (id) => document.getElementById(id);

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

    const btnEditar = document.createElement("button");
    btnEditar.textContent = "Editar";
    btnEditar.className = "btn-secondary";
    btnEditar.addEventListener("click", () => abrirEdicaoCredencial(c));

    const btnExcluir = document.createElement("button");
    btnExcluir.textContent = "Excluir";
    btnExcluir.className = "btn-secondary";
    btnExcluir.addEventListener("click", () => excluirCredencial(c.id));

    tdAcoes.appendChild(btnUsar);
    tdAcoes.appendChild(btnEditar);
    tdAcoes.appendChild(btnExcluir);

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
  span.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="${cor}"><path d="M5 3v18h2v-7h11l-3-4 3-4H7V3z"/></svg>`;
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
  calendario: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  caminhao: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
  pessoa: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
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
    flag.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M5 3v18h2v-7h11l-3-4 3-4H7V3z"/></svg>';
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
    if (iconeFlag) r.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M5 3v18h2v-7h11l-3-4 3-4H7V3z"/></svg>';
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
let implantacaoLarguraObjetivo = Number(localStorage.getItem("implantacaoLarguraObjetivo")) || 260;

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
    btnEditar.textContent = "⚙";
    btnEditar.title = "Editar cliente";
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
  wrap.appendChild(construirFichaHeader(implantacao, migracao, true));
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

const overlayImplantacaoTimeline = el("overlay-implantacao-timeline");
const implantacaoTimelineTitulo = el("implantacao-timeline-titulo");
const implantacaoTimelineSetores = el("implantacao-timeline-setores");

const overlayImplantacaoEvento = el("overlay-implantacao-evento");
const formImplantacaoEvento = el("form-implantacao-evento");
const implantacaoEventoModalTitulo = el("implantacao-evento-modal-titulo");
const inputImplantacaoEventoTitulo = el("implantacao-evento-titulo");
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
  btnEditar.textContent = "⚙";
  btnEditar.title = "Editar";
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
    btnConfig.textContent = "⚙";
    btnConfig.title = "Configurar CS, plataforma, percentual...";
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
function tornarColunasRedimensionaveis(table, chaveArmazenamento) {
  const ths = Array.from(table.querySelectorAll("thead th"));
  const linhas = Array.from(table.querySelectorAll("tbody tr"));
  let larguras = {};
  try {
    larguras = JSON.parse(localStorage.getItem(chaveArmazenamento) || "{}");
  } catch (err) {
    larguras = {};
  }

  ths.forEach((th, i) => {
    const tds = linhas.map((tr) => tr.children[i]).filter(Boolean);
    if (larguras[i]) {
      th.style.width = `${larguras[i]}px`;
      tds.forEach((td) => { td.style.width = `${larguras[i]}px`; });
    }
    th.classList.add("th-redimensionavel");
    const alca = document.createElement("span");
    alca.className = "col-resize-handle";
    alca.title = "Arraste para redimensionar";
    th.appendChild(alca);
    alca.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = th.offsetWidth;
      function aoMover(ev) {
        const nova = Math.max(40, startWidth + (ev.clientX - startX));
        th.style.width = `${nova}px`;
        tds.forEach((td) => { td.style.width = `${nova}px`; });
      }
      function aoSoltar() {
        document.removeEventListener("mousemove", aoMover);
        document.removeEventListener("mouseup", aoSoltar);
        larguras[i] = th.offsetWidth;
        localStorage.setItem(chaveArmazenamento, JSON.stringify(larguras));
      }
      document.addEventListener("mousemove", aoMover);
      document.addEventListener("mouseup", aoSoltar);
    });
  });
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
  inputArquivo.value = "";
  arquivoNome.textContent = "Nenhum arquivo selecionado";
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

function renderMapaCampos() {
  mapaCampos.innerHTML = "";
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
const overlayComando = el("overlay-comando");
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

el("btn-abrir-envio-comando").addEventListener("click", () => {
  overlayComando.classList.remove("hidden");
});

el("comando-modal-fechar").addEventListener("click", () => overlayComando.classList.add("hidden"));
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
const overlayConversor = el("overlay-conversor");
const conversorInputArquivo = el("conversor-input-arquivo");
const conversorArquivoNome = el("conversor-arquivo-nome");
const conversorTipo = el("conversor-tipo");
const conversorCategoria = el("conversor-categoria");
const conversorGrupo = el("conversor-grupo");
const conversorTolerancia = el("conversor-tolerancia");
const btnConversorConverter = el("btn-conversor-converter");
const conversorResultado = el("conversor-resultado");
const conversorCores = el("conversor-cores");

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

function abrirModalConversor() {
  estado.conversorArquivo = null;
  estado.conversorCor = null;
  conversorInputArquivo.value = "";
  conversorArquivoNome.textContent = "Nenhum arquivo selecionado";
  conversorTipo.value = "areas";
  conversorCategoria.value = "";
  conversorGrupo.value = "";
  conversorTolerancia.value = "";
  conversorResultado.innerHTML = "";
  renderConversorCores();
  btnConversorConverter.disabled = true;
  btnConversorConverter.textContent = "Converter arquivo";
  overlayConversor.classList.remove("hidden");
}

el("card-ferramentas-conversor-kml").addEventListener("click", () => {
  abrirModalConversor();
});

el("conversor-modal-fechar").addEventListener("click", () => overlayConversor.classList.add("hidden"));
conversorInputArquivo.addEventListener("change", () => {
  const file = conversorInputArquivo.files[0];
  estado.conversorArquivo = file || null;
  conversorArquivoNome.textContent = file ? file.name : "Nenhum arquivo selecionado";
  btnConversorConverter.disabled = !file;
});

// --- QUEBRA STRING (rastreadores) ---
const overlayQuebraString = el("overlay-quebra-string");
const quebraStringInput = el("quebra-string-input");
const quebraStringBytesView = el("quebra-string-bytes");
const btnQuebraString = el("btn-quebra-string");
const quebraStringResultado = el("quebra-string-resultado");

// Conjunto padronizado de informações exibidas para qualquer rastreador.
// chave = o que cada parser de protocolo (parseGT06Pacote22 etc.) deve preencher.
const QUEBRA_STRING_CAMPOS = [
  { chave: "possivelRastreador", label: "Possível rastreador" },
  { chave: "tipoPacote", label: "Tipo de pacote" },
  { chave: "idImei", label: "ID/IMEI" },
  { chave: "data", label: "Data" },
  { chave: "hora", label: "Hora" },
  { chave: "latitude", label: "Latitude" },
  { chave: "longitude", label: "Longitude" },
  { chave: "velocidade", label: "Velocidade" },
  { chave: "ignicao", label: "Ignição" },
  { chave: "odometro", label: "Odômetro" },
  { chave: "horimetro", label: "Horímetro" },
  { chave: "tipoUpload", label: "Tipo de upload" },
  { chave: "motorista", label: "Motorista" },
  { chave: "entrada1", label: "Entrada 1" },
  { chave: "entrada2", label: "Entrada 2" },
  { chave: "entrada3", label: "Entrada 3" },
  { chave: "saida1", label: "Saída 1" },
  { chave: "saida2", label: "Saída 2" },
  { chave: "saida3", label: "Saída 3" },
];

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

// GPS data upload mode (não vale para a série 06).
const GT06_TIPO_UPLOAD = {
  "00": "Envio por intervalo de tempo",
  "01": "Envio por intervalo de distância",
  "02": "Envio por ponto de inflexão",
  "03": "Envio por status do ACC",
  "04": "Reenvio do último ponto GPS ao voltar a ficar parado",
  "05": "Envio do último ponto válido ao recuperar a rede",
};

// Formato brasileiro: vírgula decimal, sinal negativo quando aplicável (sul/oeste).
function formatarCoordenada(valor) {
  return valor.toFixed(6).replace(".", ",");
}

// Protocolo GT06 (Concox e compatíveis) — pacote de posição, Protocol Number 0x22.
// Layout mapeado a partir de um exemplo de pacote real informado pelo usuário;
// bytes sem correspondência num dos campos padronizados (curso/status e outros
// ainda não mapeados) ficam de fora do resultado.
function parseGT06Pacote22(bytes) {
  const campos = {};

  const marcar = (chave, inicioByte, qtdBytes, calcularFinal) => {
    const bruto = bytes.slice(inicioByte, inicioByte + qtdBytes).join("");
    campos[chave] = { bruto, final: calcularFinal(bruto), inicioByte, fimByte: inicioByte + qtdBytes };
  };

  // Início "7878" identifica a família de protocolo GT06.
  campos.possivelRastreador = {
    bruto: bytes.slice(0, 2).join(""),
    final: "GT06 (J16, CRX, ETC)",
    inicioByte: 0,
    fimByte: 2,
  };

  marcar("tipoPacote", 3, 1, () => "Pacote de posição x22");

  // Bytes 4-9: Ano, Mês, Dia, Hora, Min, Seg — cada um é o valor hex direto (não BCD).
  const anoB = hexParaInt(bytes[4]);
  const mesB = hexParaInt(bytes[5]);
  const diaB = hexParaInt(bytes[6]);
  const horaB = hexParaInt(bytes[7]);
  const minB = hexParaInt(bytes[8]);
  const segB = hexParaInt(bytes[9]);
  const dataUtc = new Date(Date.UTC(2000 + anoB, mesB - 1, diaB, horaB, minB, segB));
  // Pacote vem em UTC; exibição em horário de Brasília (UTC-3).
  const dataBrasilia = new Date(dataUtc.getTime() - 3 * 60 * 60 * 1000);

  campos.data = {
    bruto: bytes.slice(4, 7).join(""),
    final: formatarDataBR(dataBrasilia),
    inicioByte: 4,
    fimByte: 7,
  };
  campos.hora = {
    bruto: bytes.slice(7, 10).join(""),
    final: formatarHoraBR(dataBrasilia),
    inicioByte: 7,
    fimByte: 10,
  };

  // Bytes 20-21 ("Course and Status"): bit10 = hemisfério da latitude (1=Norte, 0=Sul),
  // bit11 = hemisfério da longitude (1=Oeste, 0=Leste). Não fazia parte da lista de
  // campos que você mapeou — usei o layout padrão do protocolo GT06 para o sinal.
  const cursoStatus = hexParaInt(bytes[20] + bytes[21]);
  const sinalLat = cursoStatus & 0x0400 ? 1 : -1;
  const sinalLon = cursoStatus & 0x0800 ? -1 : 1;

  marcar("latitude", 11, 4, (bruto) => formatarCoordenada(sinalLat * (hexParaInt(bruto) / 1800000)));
  marcar("longitude", 15, 4, (bruto) => formatarCoordenada(sinalLon * (hexParaInt(bruto) / 1800000)));
  marcar("velocidade", 19, 1, (bruto) => `${hexParaInt(bruto)} km/h`);
  marcar("ignicao", 30, 1, (bruto) => (hexParaInt(bruto) === 0 ? "Desligada" : "Ligada"));
  marcar("tipoUpload", 31, 1, (bruto) => GT06_TIPO_UPLOAD[bruto] || `Desconhecido (0x${bruto})`);
  marcar("odometro", 33, 4, (bruto) => `${(hexParaInt(bruto) / 100).toFixed(2)} km`);

  return campos;
}

// Identifica o protocolo pelo cabeçalho e delega a extração dos campos.
// Devolve { campos, bytes }: campos[chave] = { bruto, final, inicioByte, fimByte }
// (inicioByte/fimByte faltando = campo não encontrado nessa string → exibe "-").
function quebrarString(strBruta) {
  const hexLimpo = (strBruta || "").replace(/\s+/g, "").toUpperCase();
  if (!hexLimpo || hexLimpo.length % 2 !== 0 || !/^[0-9A-F]+$/.test(hexLimpo)) {
    return { campos: {}, bytes: [] };
  }

  const bytes = hexParaBytes(hexLimpo);
  let campos = {};

  if (bytes[0] === "78" && bytes[1] === "78" && bytes[3] === "22") {
    campos = parseGT06Pacote22(bytes);
  }

  return { campos, bytes };
}

function renderQuebraStringBytes(bytes) {
  quebraStringBytesView.innerHTML = "";
  bytes.forEach((byte, i) => {
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

function renderQuebraStringResultado(campos) {
  quebraStringResultado.innerHTML = "";

  const tabela = document.createElement("table");
  tabela.className = "tabela-saida quebra-string-tabela";

  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th></th><th>Info no Pacote</th><th>Info final</th></tr>";
  tabela.appendChild(thead);

  const tbody = document.createElement("tbody");

  QUEBRA_STRING_CAMPOS.forEach(({ chave, label }) => {
    const campo = campos[chave] || {};
    const tr = document.createElement("tr");

    const tdLabel = document.createElement("td");
    tdLabel.textContent = label;

    const tdBruto = document.createElement("td");
    tdBruto.textContent = campo.bruto ? campo.bruto : "-";

    const tdFinal = document.createElement("td");
    tdFinal.textContent = campo.final ? String(campo.final) : "-";

    if (campo.inicioByte !== undefined) {
      tdBruto.classList.add("quebra-string-bruto-ativo");
      tdBruto.addEventListener("mouseenter", () => destacarBytes(campo.inicioByte, campo.fimByte, true));
      tdBruto.addEventListener("mouseleave", () => destacarBytes(campo.inicioByte, campo.fimByte, false));
    }

    tr.appendChild(tdLabel);
    tr.appendChild(tdBruto);
    tr.appendChild(tdFinal);
    tbody.appendChild(tr);
  });

  tabela.appendChild(tbody);
  quebraStringResultado.appendChild(tabela);
}

function abrirModalQuebraString() {
  quebraStringInput.value = "";
  btnQuebraString.disabled = true;
  quebraStringBytesView.innerHTML = "";
  renderQuebraStringResultado({});
  overlayQuebraString.classList.remove("hidden");
}

el("card-ferramentas-quebra-string").addEventListener("click", () => {
  abrirModalQuebraString();
});

el("quebra-string-modal-fechar").addEventListener("click", () => overlayQuebraString.classList.add("hidden"));
quebraStringInput.addEventListener("input", () => {
  btnQuebraString.disabled = !quebraStringInput.value.trim();
});

btnQuebraString.addEventListener("click", () => {
  const { campos, bytes } = quebrarString(quebraStringInput.value);
  renderQuebraStringBytes(bytes);
  renderQuebraStringResultado(campos);
});

function mostrarErroConversor(msg) {
  conversorResultado.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.style.color = "#b91c1c";
  p.textContent = "Erro: " + msg;
  conversorResultado.appendChild(p);
}

function renderConversorResultado(convId, data) {
  conversorResultado.innerHTML = "";

  const tiles = document.createElement("div");
  tiles.className = "dashboard-tiles";
  [
    { valor: data.n_ok, label: "Prontos" },
    { valor: data.n_erro, label: "Com erro" },
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
  legenda.textContent = `${data.n_ok} de ${data.total} registro(s) prontos para importar.`;
  conversorResultado.appendChild(legenda);

  if (data.n_ok > data.tamanho_parte) {
    const aviso = document.createElement("p");
    aviso.className = "placeholder";
    aviso.style.color = "#a16207";
    aviso.textContent = `O SSX importa no máximo ${data.max_linhas_importacao} linhas por arquivo. Os ${data.n_ok} registros prontos foram divididos em ${data.n_partes} arquivo(s) de até ${data.tamanho_parte} cada — importe um de cada vez.`;
    conversorResultado.appendChild(aviso);
  }

  if (data.n_ok > 0) {
    const downloads = document.createElement("div");
    downloads.className = "conversor-downloads";
    for (let parte = 1; parte <= data.n_partes; parte++) {
      const sufixoParte = data.n_partes > 1 ? ` (parte ${parte}/${data.n_partes})` : "";

      const btnKml = document.createElement("button");
      btnKml.className = "btn-secondary";
      btnKml.textContent = `Baixar KML${sufixoParte}`;
      btnKml.addEventListener("click", () => {
        window.location.href = `/api/conversor/download/${convId}/kml/${parte}`;
      });

      const btnCsv = document.createElement("button");
      btnCsv.className = "btn-secondary";
      btnCsv.textContent = `Baixar CSV${sufixoParte}`;
      btnCsv.addEventListener("click", () => {
        window.location.href = `/api/conversor/download/${convId}/csv/${parte}`;
      });

      downloads.appendChild(btnKml);
      downloads.appendChild(btnCsv);
    }
    conversorResultado.appendChild(downloads);
  }

  const ac = data.avisos_compactados || {};
  const compactadosTextos = [
    ac.anel_fechado ? `${ac.anel_fechado} anel(éis) de área fechados automaticamente` : null,
    ac.geo_truncado ? `${ac.geo_truncado} GeoIntegrationCode(s) truncados` : null,
    ac.coordenadas_longas ? `${ac.coordenadas_longas} registro(s) com coordenadas longas` : null,
  ].filter(Boolean);
  if (compactadosTextos.length > 0) {
    const infoAvisos = document.createElement("p");
    infoAvisos.className = "placeholder";
    infoAvisos.textContent = `Informativos: ${compactadosTextos.join(" · ")}.`;
    conversorResultado.appendChild(infoAvisos);
  }

  if (data.problematicos.length > 0) {
    const titulo = document.createElement("h4");
    titulo.textContent = `Registros com erro/aviso (${data.problematicos.length})`;
    conversorResultado.appendChild(titulo);

    const table = document.createElement("table");
    table.className = "tabela-saida";
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th></th><th>Registro</th><th>Código</th><th>Mensagens</th></tr>";
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    data.problematicos.forEach((r) => {
      const tr = document.createElement("tr");

      const tdStatus = document.createElement("td");
      tdStatus.textContent = r.erros.length ? "🔴" : "🟢";
      tr.appendChild(tdStatus);

      const tdInfo = document.createElement("td");
      const nomeLinha = document.createElement("div");
      nomeLinha.textContent = `#${r.indice} · ${r.nome}`;
      const tipoLinha = document.createElement("div");
      tipoLinha.className = "conversor-tipo-registro";
      tipoLinha.textContent = (r.tipo_original || "sem geometria") + (r.convertido ? " → Área" : "");
      tdInfo.appendChild(nomeLinha);
      tdInfo.appendChild(tipoLinha);
      tr.appendChild(tdInfo);

      const tdCodigo = document.createElement("td");
      tdCodigo.textContent = r.codigo;
      tr.appendChild(tdCodigo);

      const tdMsg = document.createElement("td");
      tdMsg.className = "conversor-mensagens";
      const msgs = [...r.erros.map((m) => `⛔ ${m}`), ...r.avisos.map((m) => `⚠️ ${m}`)];
      tdMsg.textContent = msgs.join("\n");
      tr.appendChild(tdMsg);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    conversorResultado.appendChild(table);

    if (data.problematicos_ocultos > 0) {
      const oculto = document.createElement("p");
      oculto.className = "placeholder";
      oculto.textContent = `... e mais ${data.problematicos_ocultos} registro(s) com erro/aviso não exibido(s) aqui (os arquivos gerados já refletem todos).`;
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
    const formData = new FormData();
    formData.append("arquivo", estado.conversorArquivo);
    formData.append("tipo", conversorTipo.value);
    formData.append("categoria", conversorCategoria.value.trim());
    formData.append("grupo", conversorGrupo.value.trim());
    formData.append("tolerancia", conversorTolerancia.value.trim());
    formData.append("cor", estado.conversorCor === null ? "" : String(estado.conversorCor));

    const r = await fetch("/api/conversor/converter", { method: "POST", body: formData });
    const data = await parseJsonResponse(r);
    if (!data.ok) {
      mostrarErroConversor(data.error || "Falha ao converter arquivo.");
      return;
    }
    renderConversorResultado(data.conv_id, data);
  } catch (err) {
    mostrarErroConversor(String(err));
  } finally {
    btnConversorConverter.disabled = false;
    btnConversorConverter.textContent = "Converter arquivo";
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
};
const NAV_BOTOES = {
  dashboard: el("nav-dashboard"),
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
  implantacao: "/implantacao",
  migracao: "/migracao",
  ferramentas: "/ferramentas",
  "minha-conta": "/minha-conta",
};
const TELA_POR_CAMINHO_RAIZ = {
  "/": "dashboard",
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
};
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

// Rastreia a tela/idcentral atuais só pra saber quando a navegação está
// SAINDO de uma Ficha vinculada — dispara a limpeza da autenticação nesse
// momento. É reforço de UX (a garantia de verdade é a checagem no backend,
// que recusa qualquer ação cujo idcentral não bata com o vínculo da sessão,
// mesmo que essa limpeza aqui não rode por algum motivo).
let telaNavAtual = null;
let idcentralNavAtual = null;
let ferramentasSubAtual = null;
// De onde a Ficha do Cliente foi aberta (Implantação ou Migração) — usado
// pelo botão Voltar da Ficha pra retornar pra lá em vez de sempre cair no
// Dashboard. Guardado também no pushState pra sobreviver ao Voltar/Avançar
// do navegador.
let fichaOrigem = "dashboard";

// Componente padrão: telas que autenticam a SSX (Ficha vinculada, login avulso
// de Importação/Consulta) não devem deixar essa autenticação viva depois que a
// pessoa sai da tela — dispara o endpoint de "sair" certo e reflete a limpeza
// no estado local. `estavaLa`/`continuaLa` já vêm calculados pelo chamador
// (precisam comparar com telaNavAtual/idcentralNavAtual/ferramentasSubAtual
// ANTES desses valores serem sobrescritos pela navegação atual). É reforço de
// UX — a garantia de verdade é sempre a checagem no backend.
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
  wrap.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>';
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
};

function atualizarTituloTopbar(tela, sub) {
  topbarTitulo.innerHTML = "";
  const principal = TITULO_TOPBAR_POR_TELA[tela] || "";
  if (tela === "ferramentas" && TITULO_TOPBAR_POR_SUB[sub]) {
    const pai = document.createElement("button");
    pai.type = "button";
    pai.className = "topbar-titulo-pai";
    pai.textContent = principal;
    pai.addEventListener("click", () => irParaTela("ferramentas"));
    const sep = document.createElement("span");
    sep.className = "topbar-titulo-sep";
    sep.textContent = "›";
    topbarTitulo.appendChild(pai);
    topbarTitulo.appendChild(sep);
    topbarTitulo.appendChild(document.createTextNode(TITULO_TOPBAR_POR_SUB[sub]));
  } else {
    topbarTitulo.textContent = principal;
  }
}

function irParaTela(tela, opcoes) {
  opcoes = opcoes || {};

  const novoSub = tela === "ferramentas" && FERRAMENTAS_SUBTELAS[opcoes.sub] ? opcoes.sub : null;

  limparAuthSeSaiuDaTela(
    telaNavAtual === "ficha" && !!idcentralNavAtual,
    tela === "ficha" && opcoes.idcentral === idcentralNavAtual,
    idcentralNavAtual && `/api/ficha/${encodeURIComponent(idcentralNavAtual)}/sair`,
    idcentralNavAtual
  );
  // Só entra pro login avulso (idcentralAutenticado vazio) — sessão vinculada
  // à Ficha já foi tratada acima. /api/logout faz session.clear() de propósito
  // (é o botão "Sair", desloga da ferramenta inteira) — aqui precisa só limpar
  // o token avulso da SSX, por isso o endpoint dedicado.
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
  idcentralNavAtual = tela === "ficha" ? opcoes.idcentral : null;
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
  if (tela === "implantacao") { atualizarSaidaHeader("Controle de Implantação", false); carregarImplantacaoClientes(); }
  if (tela === "migracao") { atualizarSaidaHeader("Controle de Migração", false); carregarClientesMigracao(); }
  if (tela === "dashboard") carregarDashboardNovo();
  if (tela === "ficha") carregarFichaCliente(opcoes.idcentral);
  if (tela === "minha-conta") { carregarMinhaConta(); carregarMinhasTarefas(); }
  if (entrandoNaImportacaoConsulta) { atualizarSaidaHeader("Saída", true); mostrarPlaceholder("Autentique-se e escolha uma consulta ou importação."); }
}

function irParaFicha(idcentral) {
  if (!idcentral) return;
  const origem = ["implantacao", "migracao", "minha-conta"].includes(telaNavAtual) ? telaNavAtual : "dashboard";
  irParaTela("ficha", { idcentral, origem });
}

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
document.querySelectorAll("[data-ferramentas-voltar]").forEach((btn) => {
  btn.addEventListener("click", () => irParaTela("ferramentas"));
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
["geral", "implantacao", "marcos", "migracao", "consulta", "importacao"].forEach((aba) => {
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
// Implantação, Marcos, Migração, Consulta, Importação). Clica e já abre
// direto a janela de configuração (abrirConfigFicha) — se o cliente só tem
// Implantação ou só Migração, ela mesma decide qual modal mostrar.
function construirFichaEngrenagem(implantacao, migracao) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-engrenagem-usuario ficha-engrenagem";
  btn.title = "Editar dados do cliente";
  btn.textContent = "⚙️";
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

// Credencial SSX do cliente (Fase 3b) — só admin vê o login/edita; qualquer
// perfil pode clicar "Autenticar" (o backend lê a senha salva, nunca manda
// ela pro navegador). O status mostrado é da SESSÃO atual (estado.*), não do
// cadastro — então reflete corretamente "autenticado" só quando o vínculo
// bate com ESTE idcentral.
function construirFichaCredencialSecao(idcentral, credencialConfigurada, credencialLogin) {
  const sec = document.createElement("div");
  sec.className = "ficha-secao";
  const h = document.createElement("h3");
  h.textContent = "Credencial SSX";
  sec.appendChild(h);

  const vinculadaAqui = estado.autenticado && estado.idcentralAutenticado === idcentral;

  const linha = document.createElement("div");
  linha.className = "ficha-credencial-linha";

  const pill = document.createElement("span");
  pill.className = "status-pill " + (vinculadaAqui ? "status-on" : "status-off");
  pill.textContent = vinculadaAqui ? "Autenticado" : "Não autenticado";
  linha.appendChild(pill);

  if (USUARIO_PERFIL_ATUAL === "adm" && credencialLogin) {
    const loginTxt = document.createElement("span");
    loginTxt.className = "ficha-credencial-login";
    loginTxt.textContent = credencialLogin;
    linha.appendChild(loginTxt);
  }

  const btnAutenticar = document.createElement("button");
  btnAutenticar.type = "button";
  btnAutenticar.className = "btn-secondary";
  btnAutenticar.textContent = "Autenticar";
  btnAutenticar.disabled = !credencialConfigurada || vinculadaAqui;
  btnAutenticar.title = !credencialConfigurada
    ? "Esse cliente ainda não tem credencial da SSX cadastrada."
    : (vinculadaAqui ? "Já autenticado" : "");
  btnAutenticar.addEventListener("click", () => autenticarFicha(idcentral));
  linha.appendChild(btnAutenticar);

  if (USUARIO_PERFIL_ATUAL === "adm") {
    const btnEditar = document.createElement("button");
    btnEditar.type = "button";
    btnEditar.className = "btn-secondary";
    btnEditar.textContent = credencialConfigurada ? "Editar credencial" : "Cadastrar credencial";
    btnEditar.addEventListener("click", () => abrirModalFichaCredencial(idcentral, credencialLogin || ""));
    linha.appendChild(btnEditar);
  }

  sec.appendChild(linha);

  // Só Consulta e Importação chamam esta função — aqui a falta de credencial
  // bloqueia mesmo a ação da tela, por isso vira alerta de verdade (não só
  // status discreto como na Visão Geral).
  if (!credencialConfigurada) {
    const aviso = document.createElement("p");
    aviso.className = "alerta-bloco";
    aviso.textContent = "⚠️ Sem credencial cadastrada — Consulta, Importação, Deletar veículos e Associar rastreadores não vão funcionar pra esse cliente até um administrador cadastrar.";
    sec.appendChild(aviso);
  }

  return sec;
}

async function autenticarFicha(idcentral) {
  try {
    const r = await fetch(`/api/ficha/${encodeURIComponent(idcentral)}/autenticar`, { method: "POST" });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao autenticar: ${data.error || "falha desconhecida"}`);
    await atualizarStatus();
    if (fichaAbaAtual === "geral") mostrarFichaAba("geral");
  } catch (err) {
    alert(`Erro ao autenticar: ${String(err)}`);
  }
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

function criarBlocoContato(label, valor) {
  const bloco = document.createElement("div");
  bloco.className = "ficha-header-contato-bloco";
  const l = document.createElement("div");
  l.className = "info-item-label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "info-item-valor";
  v.textContent = valor;
  bloco.appendChild(l);
  bloco.appendChild(v);
  return bloco;
}

// Linha do cabeçalho com dois blocos claramente rotulados — são DUAS pessoas
// diferentes e é fácil confundir uma com a outra: "Responsável (CS)" é quem
// da SystemSAT toca o cliente (implantacao.csm); "Decisor" é o contato do
// lado do cliente (gestor), e o WhatsApp da linha é sempre o dele, nunca do
// responsável. Substitui o antigo card de decisor isolado.
function construirFichaLinhaContato(implantacao) {
  const temDecisor = implantacao.decisor_nome || implantacao.decisor_whatsapp || implantacao.decisor_cidade || implantacao.decisor_estado;
  if (!implantacao.csm && !temDecisor) return null;

  const linha = document.createElement("div");
  linha.className = "ficha-header-contato";

  const blocos = document.createElement("div");
  blocos.className = "ficha-header-contato-blocos";
  blocos.appendChild(criarBlocoContato("Responsável (CS)", implantacao.csm || "não definido"));

  if (temDecisor) blocos.appendChild(construirCardDecisor(implantacao));
  linha.appendChild(blocos);
  return linha;
}

// Cardzinho do decisor (contato do lado do cliente): nome, telefone e cidade
// empilhados, com o botão do WhatsApp dentro do próprio card — antes era uma
// linha só com tudo separado por "·" e o botão solto no canto.
function construirCardDecisor(implantacao) {
  const card = document.createElement("div");
  card.className = "card-decisor";

  const info = document.createElement("div");
  info.className = "card-decisor-info";
  const rotulo = document.createElement("div");
  rotulo.className = "info-item-label";
  rotulo.textContent = "Decisor";
  const nome = document.createElement("div");
  nome.className = "card-decisor-nome";
  nome.textContent = implantacao.decisor_nome || "sem nome cadastrado";
  info.appendChild(rotulo);
  info.appendChild(nome);
  const local = [implantacao.decisor_cidade, implantacao.decisor_estado].filter(Boolean).join(" - ");
  [implantacao.decisor_whatsapp, local].filter(Boolean).forEach((texto) => {
    const linha = document.createElement("div");
    linha.className = "card-decisor-detalhe";
    linha.textContent = texto;
    info.appendChild(linha);
  });
  card.appendChild(info);

  const linkWpp = linkWhatsapp(implantacao.decisor_whatsapp);
  if (linkWpp) {
    const btnWpp = document.createElement("a");
    btnWpp.className = "card-decisor-wpp";
    btnWpp.href = linkWpp;
    btnWpp.target = "_blank";
    btnWpp.rel = "noopener";
    btnWpp.title = "Abrir conversa no WhatsApp";
    btnWpp.setAttribute("aria-label", "WhatsApp do decisor");
    btnWpp.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91A9.85 9.85 0 0 0 12.04 2zm0 18.15h-.01a8.23 8.23 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.25-8.23a8.2 8.2 0 0 1 8.24 8.24c0 4.54-3.7 8.23-8.24 8.23zm4.52-6.16c-.25-.12-1.46-.72-1.69-.8-.23-.08-.39-.12-.56.12-.16.25-.64.8-.78.97-.14.16-.29.18-.54.06-.25-.12-1.04-.38-1.99-1.23-.73-.66-1.23-1.47-1.37-1.72-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.43.12-.14.16-.25.25-.41.08-.16.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.16 0-.43.06-.66.31-.23.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.16 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.46-.6 1.67-1.18.21-.58.21-1.07.14-1.18-.06-.1-.22-.16-.47-.28z"/></svg>';
    const texto = document.createElement("span");
    texto.textContent = "WhatsApp";
    btnWpp.appendChild(texto);
    card.appendChild(btnWpp);
  }
  return card;
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
      alertas.push(diasAtraso !== null
        ? `${label} atrasado há ${diasAtraso} dia${diasAtraso === 1 ? "" : "s"}.`
        : `${label} está atrasado.`);
    }
    // Mesma regra do selo "Parado" do Kanban (clienteParado).
    if (clienteParado(implantacao)) {
      alertas.push(`Implantação parada: sem atividade há ${diasSemAtividade(implantacao)} dias.`);
    }
    if (FICHA_MOMENTOS_CRITICOS.includes(implantacao.momento)) {
      alertas.push(`Momento do cliente: ${implantacao.momento}.`);
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
  alertas.forEach((texto) => {
    const item = document.createElement("div");
    item.className = "alerta-item";
    item.textContent = `⚠️ ${texto}`;
    card.appendChild(item);
  });
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

// Versão compacta da Credencial SSX só pra Visão Geral (uma linha, sem cartão
// grande) — Consulta e Importação continuam usando construirFichaCredencialSecao
// (o bloco maior original) sem nenhuma mudança.
function construirFichaCredencialCompacta(idcentral, credencialConfigurada, credencialLogin) {
  const wrap = document.createElement("div");
  wrap.className = "ficha-operacional-bloco";

  const vinculadaAqui = estado.autenticado && estado.idcentralAutenticado === idcentral;

  const linha = document.createElement("div");
  linha.className = "credencial-compacta";

  const status = document.createElement("span");
  if (!credencialConfigurada) {
    status.className = "credencial-compacta-erro";
    status.textContent = "🔴 Credencial SSX — Não cadastrada";
  } else if (vinculadaAqui) {
    status.className = "credencial-compacta-ok";
    status.textContent = "🟢 Credencial SSX — Autenticada";
  } else {
    status.className = "credencial-compacta-pendente";
    status.textContent = "🟡 Credencial SSX — Cadastrada, não autenticada nesta sessão";
  }
  linha.appendChild(status);

  if (USUARIO_PERFIL_ATUAL === "adm" && credencialLogin) {
    const loginTxt = document.createElement("span");
    loginTxt.className = "ficha-credencial-login";
    loginTxt.textContent = credencialLogin;
    linha.appendChild(loginTxt);
  }

  const btnAutenticar = document.createElement("button");
  btnAutenticar.type = "button";
  btnAutenticar.className = "btn-secondary";
  btnAutenticar.textContent = "Autenticar";
  btnAutenticar.disabled = !credencialConfigurada || vinculadaAqui;
  btnAutenticar.title = !credencialConfigurada
    ? "Esse cliente ainda não tem credencial da SSX cadastrada."
    : (vinculadaAqui ? "Já autenticado" : "");
  btnAutenticar.addEventListener("click", () => autenticarFicha(idcentral));
  linha.appendChild(btnAutenticar);

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

function construirFichaVisaoGeral(idcentral, implantacao, migracao, credencialConfigurada, credencialLogin) {
  const wrap = document.createElement("div");
  wrap.appendChild(construirFichaHeader(implantacao, migracao, true));

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
      if (implantacao.flag) tags.appendChild(criarTagResumo(implantacao.flag, classeFlagTag(implantacao.flag)));
      if (implantacaoAtrasada(implantacao)) tags.appendChild(criarTagResumo("Atrasado", "tag-flag-red"));
      if (tags.children.length) wrap.appendChild(tags);
    }

    const contato = construirFichaLinhaContato(implantacao);
    if (contato) wrap.appendChild(contato);
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
  wrap.appendChild(construirFichaHeader(implantacao, migracao, true));

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
  sec.appendChild(acoes);

  wrap.appendChild(sec);
  return wrap;
}

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
  wrap.appendChild(construirFichaHeader(implantacao, migracao, true));

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

// Botões de Consulta/Importação (Fase 3b) — mesmos endpoints/modais de
// sempre, só que sempre mandando o idcentral da Ficha, e com resultado
// renderizado localmente aqui dentro (não no painel global #saida, que fica
// escondido tanto em Ferramentas Auxiliares quanto na Ficha).
const CONSULTA_TIPOS_FICHA = [
  ["clientes", "Listar Clientes"],
  ["veiculos", "Listar Veículos"],
  ["rastreadores", "Listar Rastreadores"],
  ["pessoas", "Listar Pessoas"],
  ["desatualizados", "Listar Desatualizados"],
  ["uos", "Listar UO's"],
];

function construirFichaConsulta(idcentral, implantacao, migracao, credencialConfigurada, credencialLogin) {
  const wrap = document.createElement("div");
  wrap.appendChild(construirFichaHeader(implantacao, migracao, true));
  wrap.appendChild(construirFichaCredencialSecao(idcentral, credencialConfigurada, credencialLogin));

  const autenticadoAqui = estado.autenticado && estado.idcentralAutenticado === idcentral;

  const sec = document.createElement("div");
  sec.className = "ficha-secao";
  const h = document.createElement("h3");
  h.textContent = "Consulta";
  sec.appendChild(h);

  const outputWrap = document.createElement("div");
  outputWrap.className = "ficha-consulta-resultado";

  const btnExportar = document.createElement("button");
  btnExportar.type = "button";
  btnExportar.className = "btn-secondary hidden";
  btnExportar.textContent = "Exportar Excel";

  let ultimaConsultaLocal = null;

  function mostrarErroLocal(msg) {
    outputWrap.innerHTML = "";
    const p = document.createElement("p");
    p.className = "placeholder";
    p.style.color = "#b91c1c";
    p.textContent = "Erro: " + msg;
    outputWrap.appendChild(p);
  }

  function renderResultadoLocal(headers, rows, sortState) {
    outputWrap.innerHTML = "";
    const table = document.createElement("table");
    table.className = "tabela-saida";
    const thead = document.createElement("thead");
    const trHead = document.createElement("tr");
    headers.forEach((rotulo, i) => {
      const th = document.createElement("th");
      th.className = "th-ordenavel";
      th.textContent = rotulo;
      if (sortState && sortState.coluna === i) {
        const seta = document.createElement("span");
        seta.className = "seta-ordenacao";
        seta.textContent = sortState.direcao === 1 ? " ▲" : " ▼";
        th.appendChild(seta);
      }
      th.addEventListener("click", () => {
        const direcao = sortState && sortState.coluna === i ? -sortState.direcao : 1;
        renderResultadoLocal(headers, ordenarLinhas(rows, i, direcao), { coluna: i, direcao });
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
    outputWrap.appendChild(table);
  }

  const toolbar = document.createElement("div");
  toolbar.className = "botoes";
  CONSULTA_TIPOS_FICHA.forEach(([tipo, rotulo]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = rotulo;
    btn.disabled = !autenticadoAqui;
    btn.addEventListener("click", async () => {
      outputWrap.innerHTML = '<p class="placeholder">Consultando...</p>';
      btnExportar.classList.add("hidden");
      try {
        const r = await fetch(`/api/list/${tipo}?idcentral=${encodeURIComponent(idcentral)}`);
        const data = await parseJsonResponse(r);
        if (!data.ok) return mostrarErroLocal(data.error || "Falha na consulta.");
        ultimaConsultaLocal = { tipo, headers: data.headers, rows: data.rows };
        renderResultadoLocal(data.headers, data.rows);
        btnExportar.classList.remove("hidden");
      } catch (err) {
        mostrarErroLocal(String(err));
      }
    });
    toolbar.appendChild(btn);
  });
  sec.appendChild(toolbar);

  btnExportar.addEventListener("click", async () => {
    if (!ultimaConsultaLocal) return;
    btnExportar.disabled = true;
    try {
      const r = await fetch("/api/exportar-excel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ultimaConsultaLocal),
      });
      if (!r.ok) throw new Error("Falha ao gerar a planilha.");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${ultimaConsultaLocal.tipo}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Erro ao exportar: ${String(err)}`);
    } finally {
      btnExportar.disabled = false;
    }
  });
  sec.appendChild(btnExportar);
  sec.appendChild(outputWrap);

  if (!autenticadoAqui) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = credencialConfigurada
      ? "Clique em Autenticar, acima, pra liberar as consultas."
      : "Cadastre a credencial SSX, acima, pra liberar as consultas.";
    sec.appendChild(p);
  }

  wrap.appendChild(sec);
  return wrap;
}

function construirFichaImportacao(idcentral, implantacao, migracao, credencialConfigurada, credencialLogin) {
  const wrap = document.createElement("div");
  wrap.appendChild(construirFichaHeader(implantacao, migracao, true));
  wrap.appendChild(construirFichaCredencialSecao(idcentral, credencialConfigurada, credencialLogin));

  const autenticadoAqui = estado.autenticado && estado.idcentralAutenticado === idcentral;

  const secImport = document.createElement("div");
  secImport.className = "ficha-secao";
  const hImport = document.createElement("h3");
  hImport.textContent = "Importação";
  secImport.appendChild(hImport);

  const toolbarImport = document.createElement("div");
  toolbarImport.className = "botoes";
  [
    ["cliente", "Importar Cliente"],
    ["veiculo", "Importar Veículo"],
    [null, "Importar Rastreador"],
    ["uo", "Importar UO"],
    ["usuario", "Importar Usuário"],
    [null, "Importar SimCard"],
  ].forEach(([tipo, rotulo]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = rotulo;
    if (!tipo) {
      btn.disabled = true;
      btn.title = "Ainda não implementado";
    } else {
      btn.disabled = !autenticadoAqui;
      btn.addEventListener("click", () => abrirModalImport(tipo, idcentral));
    }
    toolbarImport.appendChild(btn);
  });
  secImport.appendChild(toolbarImport);
  wrap.appendChild(secImport);

  const secManutencao = document.createElement("div");
  secManutencao.className = "ficha-secao";
  const hManutencao = document.createElement("h3");
  hManutencao.textContent = "Manutenção";
  secManutencao.appendChild(hManutencao);

  const toolbarManutencao = document.createElement("div");
  toolbarManutencao.className = "botoes";
  const btnDeletar = document.createElement("button");
  btnDeletar.type = "button";
  btnDeletar.textContent = "Deletar veículos";
  btnDeletar.disabled = !autenticadoAqui;
  btnDeletar.addEventListener("click", () => abrirModalDeletarVeiculos(idcentral));
  toolbarManutencao.appendChild(btnDeletar);

  const btnAssociar = document.createElement("button");
  btnAssociar.type = "button";
  btnAssociar.textContent = "Associar rastreadores";
  btnAssociar.disabled = !autenticadoAqui;
  btnAssociar.addEventListener("click", () => abrirModalAssociarRastreadores(idcentral));
  toolbarManutencao.appendChild(btnAssociar);
  secManutencao.appendChild(toolbarManutencao);
  wrap.appendChild(secManutencao);

  if (!autenticadoAqui) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = credencialConfigurada
      ? "Clique em Autenticar, acima, pra liberar a importação."
      : "Cadastre a credencial SSX, acima, pra liberar a importação.";
    wrap.appendChild(p);
  }

  return wrap;
}

function mostrarFichaAba(aba) {
  fichaAbaAtual = aba;
  el("ficha-aba-geral").classList.toggle("ativo", aba === "geral");
  el("ficha-aba-implantacao").classList.toggle("ativo", aba === "implantacao");
  el("ficha-aba-marcos").classList.toggle("ativo", aba === "marcos");
  el("ficha-aba-migracao").classList.toggle("ativo", aba === "migracao");
  el("ficha-aba-consulta").classList.toggle("ativo", aba === "consulta");
  el("ficha-aba-importacao").classList.toggle("ativo", aba === "importacao");

  const corpo = el("ficha-cliente-corpo");
  corpo.innerHTML = "";
  if (!fichaClienteAtual) return;
  const { idcentral, implantacao, migracao, migracoes, credencial_configurada, credencial_login } = fichaClienteAtual;
  if (aba === "geral") corpo.appendChild(construirFichaVisaoGeral(idcentral, implantacao, migracao, credencial_configurada, credencial_login));
  if (aba === "implantacao") corpo.appendChild(construirFichaImplantacao(implantacao, migracao));
  if (aba === "marcos") corpo.appendChild(construirFichaMarcos(implantacao, migracao));
  if (aba === "migracao") corpo.appendChild(construirFichaMigracao(implantacao, migracao, migracoes));
  if (aba === "consulta") corpo.appendChild(construirFichaConsulta(idcentral, implantacao, migracao, credencial_configurada, credencial_login));
  if (aba === "importacao") corpo.appendChild(construirFichaImportacao(idcentral, implantacao, migracao, credencial_configurada, credencial_login));
}

async function carregarFichaCliente(idcentral, aba = "geral") {
  fichaClienteAtual = null;
  el("ficha-sidebar-nome").textContent = "Carregando...";
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
    el("ficha-aba-migracao").classList.toggle("hidden", !data.migracao);
    // Cliente criado pela tela de Migração sem par na Implantação
    // (tem_implantacao=false) tem menu enxuto: só Visão Geral, Migração,
    // Consulta e Importação — sem Implantação/Marcos, que não existem pra ele.
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
