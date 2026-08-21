const el = (id) => document.getElementById(id);

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
const blocoCriarPlanilha = el("bloco-criar-planilha");
const chkCriarPlanilha = el("chk-criar-planilha");
const inputNomePlanilha = el("input-nome-planilha");
const selectClientePlanilhaExistente = el("select-cliente-planilha-existente");
const btnExportarExcel = el("btn-exportar-excel");

document.querySelectorAll(".menu-cabecalho").forEach((cabecalho) => {
  cabecalho.addEventListener("click", () => {
    cabecalho.closest(".menu-grupo").classList.toggle("aberto");
  });
});

const estado = {
  autenticado: false,
  importTipo: null,
  fileId: null,
  colunas: [],
  campos: [],
  credencialAtualNome: null,
  conversorArquivo: null,
  conversorCor: null,
  ultimaConsulta: null,
};

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
  aplicarEstadoAuth(data.authenticated);
}

function aplicarEstadoAuth(autenticado) {
  estado.autenticado = autenticado;
  const pill = el("status-auth");
  const btnLogout = el("btn-logout");
  if (autenticado) {
    pill.textContent = "Autenticado";
    pill.className = "status-pill status-on";
    btnLogout.classList.remove("hidden");
  } else {
    pill.textContent = "Não autenticado";
    pill.className = "status-pill status-off";
    btnLogout.classList.add("hidden");
  }
}

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
      aplicarEstadoAuth(true);
      el("senha").value = "";
      estado.credencialAtualNome = nomeCredencial || null;
      mostrarPlaceholder("Autenticado com sucesso! Escolha uma consulta ou importação.");
    } else {
      aplicarEstadoAuth(false);
      mostrarErro(data.error || "Falha ao autenticar.");
    }
  } catch (err) {
    mostrarErro(String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Autenticar";
  }
}

el("form-login").addEventListener("submit", (e) => {
  e.preventDefault();
  autenticarComCampos(null);
});

el("btn-logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
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

selectCredencial.addEventListener("change", async () => {
  const cred = credenciaisCache.find((c) => c.id === selectCredencial.value);
  if (!cred) return;
  el("login").value = cred.login;
  el("senha").value = cred.senha;
  await autenticarComCampos(cred.nome);
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

el("btn-gerenciar-logins").addEventListener("click", () => {
  overlayCred.classList.remove("hidden");
});
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

el("botoes-import").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-tipo]");
  if (!btn) return;
  if (!estado.autenticado) return mostrarErro("Autentique-se primeiro.");
  abrirModalImport(btn.dataset.tipo);
});

el("botoes-migracao").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-tipo='migracao-clientes']");
  if (!btn) return;
  await carregarClientesMigracao();
});

// --- DASHBOARD ---
const STATUS_COR = {
  Aguardando: "var(--azul)",
  Enviado: "var(--amarelo)",
  Migrado: "var(--verde)",
  Enviar: "var(--vermelho)",
};
const STATUS_ORDEM = ["Aguardando", "Enviado", "Migrado", "Enviar"];

el("botoes-dashboard").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-tipo='dashboard-indicadores']");
  if (!btn) return;
  await carregarDashboard();
});

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
    const v = document.createElement("div");
    v.className = "stat-tile-valor";
    v.textContent = valor;
    const l = document.createElement("div");
    l.className = "stat-tile-label";
    l.textContent = label;
    tile.appendChild(v);
    tile.appendChild(l);
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

// --- CLIENTES EM IMPLANTAÇÃO ---
const overlayImplantacaoCliente = el("overlay-implantacao-cliente");
const formImplantacaoCliente = el("form-implantacao-cliente");
const implantacaoClienteModalTitulo = el("implantacao-cliente-modal-titulo");
const inputImplantacaoClienteNome = el("implantacao-cliente-nome");
const inputImplantacaoClienteData = el("implantacao-cliente-data");
const inputImplantacaoClienteObjetivo = el("implantacao-cliente-objetivo");
const inputImplantacaoClienteValor = el("implantacao-cliente-valor");
const inputImplantacaoClienteCsm = el("implantacao-cliente-csm");
const btnSalvarImplantacaoCliente = el("btn-salvar-implantacao-cliente");

let implantacaoClienteEditandoId = null;

el("botoes-implantacao").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tipo='implantacao-clientes']");
  if (!btn) return;
  carregarImplantacaoClientes();
});

async function carregarImplantacaoClientes() {
  mostrarPlaceholder("Carregando clientes em implantação...");
  try {
    const r = await fetch("/api/implantacao/clientes");
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErro(data.error || "Falha ao carregar.");
    mostrarTabelaImplantacaoClientes(data.clientes);
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

function mostrarTabelaImplantacaoClientes(clientes) {
  const wrapper = document.createElement("div");

  const toolbar = document.createElement("div");
  toolbar.className = "migracao-toolbar";
  const btnAdicionar = document.createElement("button");
  btnAdicionar.className = "btn-primary";
  btnAdicionar.textContent = "+ Adicionar cliente";
  btnAdicionar.addEventListener("click", () => abrirModalImplantacaoCliente(null));
  toolbar.appendChild(btnAdicionar);
  wrapper.appendChild(toolbar);

  const headers = ["Cliente", "Data de entrada", "Objetivo", "Valor de contrato", "Última ação", "CSM", ""];
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
    td.textContent = "Nenhum cliente em implantação ainda.";
    td.style.color = "#6b7280";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  clientes.forEach((c) => {
    const tr = document.createElement("tr");
    tr.className = "linha-clicavel";
    tr.title = "Clique para ver a linha do tempo";
    tr.addEventListener("click", () => abrirTimelineImplantacao(c));
    [c.cliente, formatarDataBRSimples(c.data_entrada), c.objetivo, formatarMoedaBRL(c.valor_contrato), c.ultima_acao, c.csm].forEach((v) => {
      const td = document.createElement("td");
      td.textContent = v === null || v === undefined || v === "" ? "-" : String(v);
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
        const r = await fetch(`/api/implantacao/clientes/${c.id}`, { method: "DELETE" });
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
  wrapper.appendChild(table);
  setSaida(wrapper);
}

function abrirModalImplantacaoCliente(cliente) {
  implantacaoClienteEditandoId = cliente ? cliente.id : null;
  implantacaoClienteModalTitulo.textContent = cliente ? "Editar cliente" : "Adicionar cliente";
  inputImplantacaoClienteNome.value = cliente ? cliente.cliente : "";
  inputImplantacaoClienteData.value = cliente ? cliente.data_entrada || "" : "";
  inputImplantacaoClienteObjetivo.value = cliente ? cliente.objetivo || "" : "";
  inputImplantacaoClienteValor.value = cliente && cliente.valor_contrato ? cliente.valor_contrato : "";
  inputImplantacaoClienteCsm.value = cliente ? cliente.csm || "" : "";
  btnSalvarImplantacaoCliente.textContent = cliente ? "Salvar edição" : "Adicionar";
  overlayImplantacaoCliente.classList.remove("hidden");
  inputImplantacaoClienteNome.focus();
}

el("implantacao-cliente-modal-fechar").addEventListener("click", () => overlayImplantacaoCliente.classList.add("hidden"));

formImplantacaoCliente.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    cliente: inputImplantacaoClienteNome.value.trim(),
    data_entrada: inputImplantacaoClienteData.value,
    objetivo: inputImplantacaoClienteObjetivo.value.trim(),
    valor_contrato: inputImplantacaoClienteValor.value,
    csm: inputImplantacaoClienteCsm.value.trim(),
  };
  if (!payload.cliente) return;
  try {
    const url = implantacaoClienteEditandoId
      ? `/api/implantacao/clientes/${implantacaoClienteEditandoId}`
      : "/api/implantacao/clientes";
    const method = implantacaoClienteEditandoId ? "PUT" : "POST";
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao salvar: ${data.error || "falha desconhecida"}`);
    overlayImplantacaoCliente.classList.add("hidden");
    await carregarImplantacaoClientes();
  } catch (err) {
    alert(`Erro ao salvar: ${String(err)}`);
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
    const r = await fetch(`/api/implantacao/clientes/${implantacaoTimelineClienteAtual.id}/eventos`);
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
      const r = await fetch(`/api/implantacao/clientes/${implantacaoTimelineClienteAtual.id}/eventos/${ev.id}`, { method: "DELETE" });
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
      ? `/api/implantacao/clientes/${clienteId}/eventos/${implantacaoEventoEditandoId}`
      : `/api/implantacao/clientes/${clienteId}/eventos`;
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
const formMigracao = el("form-migracao");
const migracaoModalTitulo = el("migracao-modal-titulo");
const inputMigracaoCs = el("migracao-cs");
const inputMigracaoPlataforma = el("migracao-plataforma");
const inputMigracaoQtdClientes = el("migracao-qtd-clientes");
const inputMigracaoQtdPlacas = el("migracao-qtd-placas");
const inputMigracaoPercentual = el("migracao-percentual");

let clienteMigracaoAtualId = null;

async function carregarClientesMigracao() {
  mostrarPlaceholder("Carregando clientes em migração...");
  try {
    const r = await fetch("/api/migracao/clientes");
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErro(data.error || "Falha ao carregar.");
    mostrarTabelaMigracao(data.clientes);
  } catch (err) {
    mostrarErro(String(err));
  }
}

function mostrarTabelaMigracao(clientes) {
  const wrapper = document.createElement("div");

  const toolbar = document.createElement("div");
  toolbar.className = "migracao-toolbar";
  const btnAdicionarCliente = document.createElement("button");
  btnAdicionarCliente.className = "btn-primary";
  btnAdicionarCliente.textContent = "Adicionar Cliente";
  btnAdicionarCliente.addEventListener("click", adicionarClienteMigracao);
  toolbar.appendChild(btnAdicionarCliente);
  wrapper.appendChild(toolbar);

  const headers = ["Nome", "CS", "Plataforma de origem", "Quantidade de Clientes", "Quantidade de Placas", "Porcentagem da migração", ""];
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
    td.textContent = "Nenhum cliente ainda. Adicione manualmente ou importe veículos com \"Criar planilha\" marcado.";
    td.style.color = "#6b7280";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  clientes.forEach((c) => {
    const tr = document.createElement("tr");
    tr.className = "linha-clicavel";
    tr.title = "Clique para ver os veículos importados";
    tr.addEventListener("click", () => abrirVeiculosMigracao(c));
    [c.nome, c.cs, c.plataforma_origem, c.qtd_clientes, c.qtd_placas, `${c.percentual_migracao}%`].forEach((v) => {
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
    btnExcluirCliente.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Excluir o cliente "${c.nome}" e todos os veículos dele? Essa ação não pode ser desfeita.`)) return;
      try {
        const r = await fetch(`/api/migracao/clientes/${c.id}`, { method: "DELETE" });
        const data = await parseJsonResponse(r);
        if (!data.ok) return mostrarErro(data.error || "Falha ao excluir.");
        await carregarClientesMigracao();
      } catch (err) {
        mostrarErro(String(err));
      }
    });
    tdAcoes.appendChild(btnExcluirCliente);

    tr.appendChild(tdAcoes);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrapper.appendChild(table);
  setSaida(wrapper);
}

async function adicionarClienteMigracao() {
  const nome = prompt("Nome do novo cliente:");
  if (!nome || !nome.trim()) return;
  try {
    const r = await fetch("/api/migracao/clientes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nome.trim() }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return mostrarErro(data.error || "Falha ao criar cliente.");
    await carregarClientesMigracao();
  } catch (err) {
    mostrarErro(String(err));
  }
}

function abrirModalMigracao(cliente) {
  clienteMigracaoAtualId = cliente.id;
  migracaoModalTitulo.textContent = cliente.nome;
  inputMigracaoCs.value = cliente.cs || "";
  inputMigracaoPlataforma.value = cliente.plataforma_origem || "";
  inputMigracaoQtdClientes.value = cliente.qtd_clientes || 0;
  inputMigracaoQtdPlacas.value = cliente.qtd_placas || 0;
  inputMigracaoPercentual.value = cliente.percentual_migracao || 0;
  overlayMigracao.classList.remove("hidden");
}

el("migracao-modal-fechar").addEventListener("click", () => overlayMigracao.classList.add("hidden"));
formMigracao.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!clienteMigracaoAtualId) return;
  const payload = {
    cs: inputMigracaoCs.value.trim(),
    plataforma_origem: inputMigracaoPlataforma.value.trim(),
    qtd_clientes: inputMigracaoQtdClientes.value,
    qtd_placas: inputMigracaoQtdPlacas.value,
    percentual_migracao: inputMigracaoPercentual.value,
  };
  try {
    const r = await fetch(`/api/migracao/clientes/${clienteMigracaoAtualId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao salvar: ${data.error || "falha desconhecida"}`);
    overlayMigracao.classList.add("hidden");
    await carregarClientesMigracao();
  } catch (err) {
    alert(`Erro ao salvar: ${String(err)}`);
  }
});

// --- VEÍCULOS DO CLIENTE EM MIGRAÇÃO ---
const overlayVeiculosMigracao = el("overlay-veiculos-migracao");
const veiculosMigracaoTitulo = el("veiculos-migracao-titulo");
const veiculosMigracaoCorpo = el("veiculos-migracao-corpo");
const btnEnviarSelecionados = el("veiculos-migracao-enviar-selecionados");
const btnSelecionarTodosVeiculos = el("veiculos-migracao-selecionar-todos");
const btnEditarVeiculos = el("veiculos-migracao-editar");
const veiculosMigracaoEnvioStatus = el("veiculos-migracao-envio-status");

const STATUS_VEICULO_OPCOES = ["Aguardando", "Enviado", "Migrado", "Enviar"];
const STATUS_VEICULO_CLASSE = {
  Aguardando: "linha-status-aguardando",
  Enviado: "linha-status-enviado",
  Migrado: "linha-status-migrado",
  Enviar: "linha-status-enviar",
};
const CAMPOS_VEICULO_EDITAVEIS = ["cliente", "veiculo", "equipamento", "id_equipamento", "numero_linha"];

let veiculosMigracaoClienteIdAtual = null;
let veiculosMigracaoDadosAtuais = [];
let modoEdicaoVeiculos = false;

el("veiculos-migracao-fechar").addEventListener("click", () => overlayVeiculosMigracao.classList.add("hidden"));
async function abrirVeiculosMigracao(cliente) {
  veiculosMigracaoClienteIdAtual = cliente.id;
  veiculosMigracaoTitulo.textContent = `Veículos — ${cliente.nome}`;
  veiculosMigracaoCorpo.innerHTML = '<p class="placeholder">Carregando...</p>';
  veiculosMigracaoEnvioStatus.textContent = "";
  modoEdicaoVeiculos = false;
  btnEditarVeiculos.textContent = "Editar";
  btnSelecionarTodosVeiculos.textContent = "Selecionar todos";
  overlayVeiculosMigracao.classList.remove("hidden");
  await recarregarVeiculosMigracao(true);
}

let contadorLinhaBrancoVeiculo = 0;

function criarLinhaBrancoVeiculo() {
  contadorLinhaBrancoVeiculo += 1;
  return {
    id: `novo-${contadorLinhaBrancoVeiculo}`,
    cliente: "", veiculo: "", equipamento: "", id_equipamento: "", numero_linha: "", comando: "",
    status: "Aguardando",
  };
}

async function recarregarVeiculosMigracao(permitirLinhasBranco = false) {
  try {
    const r = await fetch(`/api/migracao/clientes/${veiculosMigracaoClienteIdAtual}/veiculos`);
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
      modoEdicaoVeiculos = true;
      btnEditarVeiculos.textContent = "Salvar";
    } else {
      veiculosMigracaoDadosAtuais = data.veiculos;
    }
    renderTabelaVeiculosMigracao(veiculosMigracaoClienteIdAtual, veiculosMigracaoDadosAtuais);
  } catch (err) {
    alert(`Erro ao carregar veículos: ${String(err)}`);
  }
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

  const headers = ["", "Status", "Cliente", "Veículo", "Equipamento", "ID do equipamento", "Número da linha", "Comando", "Ações"];
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
      selectStatus.title = "Salve a linha primeiro para definir o status";
    }
    selectStatus.addEventListener("change", async () => {
      const novoStatus = selectStatus.value;
      try {
        const r = await fetch(`/api/migracao/clientes/${clienteId}/veiculos/${v.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: novoStatus }),
        });
        const data = await parseJsonResponse(r);
        if (!data.ok) return alert(`Erro ao salvar status: ${data.error || "falha desconhecida"}`);
        tr.className = STATUS_VEICULO_CLASSE[novoStatus] || "";
      } catch (err) {
        alert(`Erro ao salvar status: ${String(err)}`);
      }
    });
    tdStatus.appendChild(selectStatus);
    tr.appendChild(tdStatus);

    CAMPOS_VEICULO_EDITAVEIS.forEach((campo) => {
      const td = document.createElement("td");
      if (modoEdicaoVeiculos) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "veiculo-comando-input";
        input.dataset.campo = campo;
        input.value = v[campo] || "";
        td.appendChild(input);
      } else {
        td.textContent = v[campo] || "-";
      }
      tr.appendChild(td);
    });

    const tdComando = document.createElement("td");
    const inputComando = document.createElement("input");
    inputComando.type = "text";
    inputComando.className = "veiculo-comando-input";
    inputComando.dataset.campo = "comando";
    inputComando.placeholder = "Digite o comando...";
    inputComando.value = v.comando || "";
    let ultimoComandoSalvo = inputComando.value;
    inputComando.addEventListener("blur", async () => {
      if (modoEdicaoVeiculos || inputComando.value === ultimoComandoSalvo) return;
      try {
        const r = await fetch(`/api/migracao/clientes/${clienteId}/veiculos/${v.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comando: inputComando.value }),
        });
        const data = await parseJsonResponse(r);
        if (!data.ok) return alert(`Erro ao salvar comando: ${data.error || "falha desconhecida"}`);
        ultimoComandoSalvo = inputComando.value;
      } catch (err) {
        alert(`Erro ao salvar comando: ${String(err)}`);
      }
    });
    tdComando.appendChild(inputComando);
    tr.appendChild(tdComando);

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

    if (modoEdicaoVeiculos) {
      const btnAdicionarLinha = document.createElement("button");
      btnAdicionarLinha.className = "btn-enviar-icone btn-adicionar-linha";
      btnAdicionarLinha.textContent = "+";
      btnAdicionarLinha.title = "Adicionar nova linha";
      btnAdicionarLinha.addEventListener("click", () => {
        veiculosMigracaoDadosAtuais.push(criarLinhaBrancoVeiculo());
        renderTabelaVeiculosMigracao(clienteId, veiculosMigracaoDadosAtuais);
      });
      tdAcoes.appendChild(btnAdicionarLinha);
    }

    tr.appendChild(tdAcoes);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  veiculosMigracaoCorpo.appendChild(table);
}

btnSelecionarTodosVeiculos.addEventListener("click", () => {
  const checkboxes = Array.from(veiculosMigracaoCorpo.querySelectorAll(".veiculo-checkbox"));
  if (checkboxes.length === 0) return;
  const todosMarcados = checkboxes.every((cb) => cb.checked);
  checkboxes.forEach((cb) => { cb.checked = !todosMarcados; });
  btnSelecionarTodosVeiculos.textContent = todosMarcados ? "Selecionar todos" : "Desmarcar todos";
});

btnEditarVeiculos.addEventListener("click", async () => {
  if (!modoEdicaoVeiculos) {
    modoEdicaoVeiculos = true;
    btnEditarVeiculos.textContent = "Salvar";
    renderTabelaVeiculosMigracao(veiculosMigracaoClienteIdAtual, veiculosMigracaoDadosAtuais);
    return;
  }

  const linhas = Array.from(veiculosMigracaoCorpo.querySelectorAll("tbody tr"));
  const itens = linhas.map((tr) => {
    const item = { id: tr.dataset.veiculoId };
    CAMPOS_VEICULO_EDITAVEIS.forEach((campo) => {
      const input = tr.querySelector(`[data-campo="${campo}"]`);
      if (input) item[campo] = input.value;
    });
    const inputComando = tr.querySelector('[data-campo="comando"]');
    if (inputComando) item.comando = inputComando.value;
    return item;
  });

  btnEditarVeiculos.disabled = true;
  try {
    const r = await fetch(`/api/migracao/clientes/${veiculosMigracaoClienteIdAtual}/veiculos/salvar-lote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ veiculos: itens }),
    });
    const data = await parseJsonResponse(r);
    if (!data.ok) return alert(`Erro ao salvar edições: ${data.error || "falha desconhecida"}`);

    // Atualiza os dados locais com o que acabou de ser salvo e já volta pro modo
    // normal (sem depender do round-trip de um novo GET pra sair da edição).
    itens.forEach((item) => {
      const registro = veiculosMigracaoDadosAtuais.find((v) => v.id === item.id);
      if (registro) Object.assign(registro, item);
    });
    modoEdicaoVeiculos = false;
    btnEditarVeiculos.textContent = "Editar";
    renderTabelaVeiculosMigracao(veiculosMigracaoClienteIdAtual, veiculosMigracaoDadosAtuais);
    recarregarVeiculosMigracao();
  } catch (err) {
    alert(`Erro ao salvar edições: ${String(err)}`);
  } finally {
    btnEditarVeiculos.disabled = false;
  }
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
    const inputNumero = tr.querySelector('[data-campo="numero_linha"]');
    const btnLinha = tr.querySelector(".btn-enviar-icone");
    const numeroLinha = inputNumero ? inputNumero.value : (tr.children[6]?.textContent || "");
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

async function abrirModalImport(tipo) {
  estado.importTipo = tipo;
  estado.fileId = null;
  estado.colunas = [];
  inputArquivo.value = "";
  arquivoNome.textContent = "Nenhum arquivo selecionado";
  progressoContainer.classList.add("hidden");
  progressoBar.style.width = "0%";
  progressoPct.textContent = "0%";
  btnIniciarImport.disabled = true;
  btnIniciarImport.textContent = "Iniciar Importação";

  if (tipo === "veiculo") {
    blocoCriarPlanilha.classList.remove("hidden");
    chkCriarPlanilha.checked = false;
    inputNomePlanilha.value = estado.credencialAtualNome || "";
    inputNomePlanilha.classList.add("hidden");
    selectClientePlanilhaExistente.value = "";
    carregarClientesExistentesPlanilha();
  } else {
    blocoCriarPlanilha.classList.add("hidden");
    chkCriarPlanilha.checked = false;
  }

  const r = await fetch(`/api/import/params/${tipo}`);
  const data = await parseJsonResponse(r);
  if (!data.ok) return mostrarErro(data.error || "Tipo desconhecido.");

  modalTitulo.textContent = `Mapeamento: ${data.titulo}`;
  estado.campos = data.campos;
  renderMapaCampos();
  overlay.classList.remove("hidden");
}

async function carregarClientesExistentesPlanilha() {
  selectClientePlanilhaExistente.innerHTML = '<option value="">Cliente existente...</option>';
  try {
    const r = await fetch("/api/migracao/clientes");
    const data = await parseJsonResponse(r);
    if (!data.ok) return;
    data.clientes.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.nome;
      opt.textContent = c.nome;
      selectClientePlanilhaExistente.appendChild(opt);
    });
  } catch (err) {
    // silencioso: a lista é só uma conveniência, não bloqueia a importação
  }
}

chkCriarPlanilha.addEventListener("change", () => {
  inputNomePlanilha.classList.toggle("hidden", !chkCriarPlanilha.checked);
});

selectClientePlanilhaExistente.addEventListener("change", () => {
  if (!selectClientePlanilhaExistente.value) return;
  chkCriarPlanilha.checked = true;
  inputNomePlanilha.value = selectClientePlanilhaExistente.value;
  inputNomePlanilha.classList.remove("hidden");
});

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

        if (job.planilha) {
          const divPlanilha = document.createElement("div");
          divPlanilha.className = "resumo-final";
          divPlanilha.textContent = `Cliente "${job.planilha.nome}" atualizado em Clientes em migração: ${job.planilha.qtd_clientes} clientes, ${job.planilha.qtd_placas} placas.`;
          logContainer.appendChild(divPlanilha);
        }

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

  const criarPlanilha = estado.importTipo === "veiculo" && chkCriarPlanilha.checked;
  const nomeClientePlanilha = inputNomePlanilha.value.trim();
  if (criarPlanilha && !nomeClientePlanilha) {
    return mostrarErro("Informe o nome do cliente para criar a planilha em Clientes em migração.");
  }

  btnIniciarImport.disabled = true;
  btnIniciarImport.textContent = "Importando...";
  progressoContainer.classList.remove("hidden");
  progressoBar.style.width = "0%";
  progressoPct.textContent = "0%";
  progressoStatus.textContent = "Iniciando...";

  const logContainer = document.createElement("div");
  setSaida(logContainer);
  importLogsMostrados = 0;

  try {
    const resp = await fetch("/api/import/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tipo: estado.importTipo,
        file_id: estado.fileId,
        mapping,
        criar_planilha: criarPlanilha,
        nome_cliente_planilha: nomeClientePlanilha,
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

el("botoes-migracao").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tipo='envio-comando']");
  if (!btn) return;
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

el("botoes-ferramentas").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tipo='conversor-kml']");
  if (!btn) return;
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

el("botoes-ferramentas").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tipo='quebra-string']");
  if (!btn) return;
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
    const v = document.createElement("div");
    v.className = "stat-tile-valor";
    v.textContent = valor;
    const l = document.createElement("div");
    l.className = "stat-tile-label";
    l.textContent = label;
    tile.appendChild(v);
    tile.appendChild(l);
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

el("botoes-ferramentas").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tipo='comandos']");
  if (!btn) return;
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
const inputUsuarioAdmin = el("usuario-admin");
const btnSalvarUsuario = el("btn-salvar-usuario");
const btnCancelarEdicaoUsuario = el("btn-cancelar-edicao-usuario");
const usuarioFormTitulo = el("usuario-form-titulo");
const btnGerenciarUsuarios = el("btn-gerenciar-usuarios");

let usuariosCache = [];
let editandoUsuarioId = null;

async function carregarAppUsuarios() {
  const r = await fetch("/api/app-usuarios");
  const data = await parseJsonResponse(r);
  if (!data.ok) return mostrarErro(data.error || "Falha ao carregar usuários.");
  usuariosCache = data.usuarios || [];
  renderListaUsuarios();
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
  thead.innerHTML = "<tr><th>Usuário</th><th>Admin</th><th></th></tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  usuariosCache
    .slice()
    .sort((a, b) => a.usuario.localeCompare(b.usuario, "pt-BR"))
    .forEach((u) => {
      const tr = document.createElement("tr");

      const tdNome = document.createElement("td");
      tdNome.textContent = u.usuario;

      const tdAdmin = document.createElement("td");
      tdAdmin.textContent = u.admin ? "Sim" : "Não";

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
      tr.appendChild(tdAdmin);
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
  btnSalvarUsuario.textContent = "Adicionar";
  btnCancelarEdicaoUsuario.classList.add("hidden");
  usuarioFormTitulo.textContent = "Adicionar usuário";
}

function abrirEdicaoUsuario(u) {
  inputUsuarioNome.value = u.usuario;
  inputUsuarioSenha.value = "";
  inputUsuarioSenha.placeholder = "Senha (deixe em branco pra manter)";
  inputUsuarioSenha.required = false;
  inputUsuarioAdmin.checked = !!u.admin;
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
    admin: inputUsuarioAdmin.checked,
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
    if (!data.ok) return mostrarErro(data.error || "Falha ao salvar usuário.");
    resetFormUsuario();
    await carregarAppUsuarios();
  } catch (err) {
    mostrarErro(String(err));
  }
});

async function excluirAppUsuario(id) {
  if (!confirm("Excluir este usuário?")) return;
  const r = await fetch(`/api/app-usuarios/${id}`, { method: "DELETE" });
  const data = await parseJsonResponse(r);
  if (!data.ok) return mostrarErro(data.error || "Falha ao excluir.");
  await carregarAppUsuarios();
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

el("btn-minha-senha").addEventListener("click", () => {
  appMenuDropdown.classList.add("hidden");
  formMinhaSenha.reset();
  minhaSenhaMsg.textContent = "";
  overlayMinhaSenha.classList.remove("hidden");
});
el("minha-senha-fechar").addEventListener("click", () => overlayMinhaSenha.classList.add("hidden"));

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

atualizarStatus();
