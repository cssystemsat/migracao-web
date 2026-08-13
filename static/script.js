const el = (id) => document.getElementById(id);

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
};

function setSaida(node) {
  saida.innerHTML = "";
  saida.appendChild(node);
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

function mostrarTabela(headers, rows) {
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
}

async function atualizarStatus() {
  const r = await fetch("/api/status");
  const data = await r.json();
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
    const data = await r.json();
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
  const data = await r.json();
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
    const data = await r.json();
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
  const data = await r.json();
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
overlayCred.addEventListener("click", (e) => {
  if (e.target === overlayCred) {
    overlayCred.classList.add("hidden");
    resetFormCredencial();
  }
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
    const data = await r.json();
    if (data.ok) {
      mostrarTabela(data.headers, data.rows);
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
    const data = await r.json();
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
        const data = await r.json();
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
    const data = await r.json();
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
overlayMigracao.addEventListener("click", (e) => {
  if (e.target === overlayMigracao) overlayMigracao.classList.add("hidden");
});

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
    const data = await r.json();
    if (!data.ok) return mostrarErro(data.error || "Falha ao salvar.");
    overlayMigracao.classList.add("hidden");
    await carregarClientesMigracao();
  } catch (err) {
    mostrarErro(String(err));
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
overlayVeiculosMigracao.addEventListener("click", (e) => {
  if (e.target === overlayVeiculosMigracao) overlayVeiculosMigracao.classList.add("hidden");
});

async function abrirVeiculosMigracao(cliente) {
  veiculosMigracaoClienteIdAtual = cliente.id;
  veiculosMigracaoTitulo.textContent = `Veículos — ${cliente.nome}`;
  veiculosMigracaoCorpo.innerHTML = '<p class="placeholder">Carregando...</p>';
  veiculosMigracaoEnvioStatus.textContent = "";
  modoEdicaoVeiculos = false;
  btnEditarVeiculos.textContent = "Editar";
  btnSelecionarTodosVeiculos.textContent = "Selecionar todos";
  overlayVeiculosMigracao.classList.remove("hidden");
  await recarregarVeiculosMigracao();
}

async function recarregarVeiculosMigracao() {
  try {
    const r = await fetch(`/api/migracao/clientes/${veiculosMigracaoClienteIdAtual}/veiculos`);
    const data = await r.json();
    if (!data.ok) {
      veiculosMigracaoCorpo.innerHTML = "";
      return mostrarErro(data.error || "Falha ao carregar veículos.");
    }
    veiculosMigracaoDadosAtuais = data.veiculos;
    renderTabelaVeiculosMigracao(veiculosMigracaoClienteIdAtual, veiculosMigracaoDadosAtuais);
  } catch (err) {
    mostrarErro(String(err));
  }
}

function renderTabelaVeiculosMigracao(clienteId, veiculos) {
  veiculosMigracaoCorpo.innerHTML = "";

  if (veiculos.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "Nenhum veículo importado para esse cliente ainda.";
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
    selectStatus.addEventListener("change", async () => {
      const novoStatus = selectStatus.value;
      try {
        const r = await fetch(`/api/migracao/clientes/${clienteId}/veiculos/${v.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: novoStatus }),
        });
        const data = await r.json();
        if (!data.ok) return mostrarErro(data.error || "Falha ao salvar status.");
        tr.className = STATUS_VEICULO_CLASSE[novoStatus] || "";
      } catch (err) {
        mostrarErro(String(err));
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
        const data = await r.json();
        if (!data.ok) return mostrarErro(data.error || "Falha ao salvar comando.");
        ultimoComandoSalvo = inputComando.value;
      } catch (err) {
        mostrarErro(String(err));
      }
    });
    tdComando.appendChild(inputComando);
    tr.appendChild(tdComando);

    const tdAcoes = document.createElement("td");
    const btnEnviar = document.createElement("button");
    btnEnviar.className = "btn-enviar-icone";
    btnEnviar.textContent = "➤";
    btnEnviar.title = "Enviar comando para essa linha";
    btnEnviar.addEventListener("click", async () => {
      await enviarComandoLinhaVeiculo(btnEnviar, v.numero_linha, inputComando.value);
    });
    tdAcoes.appendChild(btnEnviar);
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
    const data = await r.json();
    if (!data.ok) return mostrarErro(data.error || "Falha ao salvar edições.");

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
    mostrarErro(String(err));
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
    const data = await r.json();
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
  if (linhas.length === 0) return mostrarErro("Marque ao menos um veículo pra enviar.");

  btnEnviarSelecionados.disabled = true;
  let sucessos = 0;
  let erros = 0;

  for (let i = 0; i < linhas.length; i++) {
    const tr = linhas[i];
    veiculosMigracaoEnvioStatus.textContent = `Enviando ${i + 1} de ${linhas.length}...`;
    const inputComando = tr.querySelector('[data-campo="comando"]');
    const inputNumero = tr.querySelector('[data-campo="numero_linha"]');
    const btnLinha = tr.querySelector(".btn-enviar-icone");
    const numeroLinha = inputNumero ? inputNumero.value : (tr.children[6]?.textContent || "");
    const resultado = await enviarComandoLinhaVeiculo(btnLinha, numeroLinha, inputComando ? inputComando.value : "");
    if (resultado.ok) sucessos++;
    else erros++;
  }

  veiculosMigracaoEnvioStatus.textContent = `Concluído! Sucessos: ${sucessos} | Erros: ${erros}`;
  btnEnviarSelecionados.disabled = false;
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
  } else {
    blocoCriarPlanilha.classList.add("hidden");
    chkCriarPlanilha.checked = false;
  }

  const r = await fetch(`/api/import/params/${tipo}`);
  const data = await r.json();
  if (!data.ok) return mostrarErro(data.error || "Tipo desconhecido.");

  modalTitulo.textContent = `Mapeamento: ${data.titulo}`;
  estado.campos = data.campos;
  renderMapaCampos();
  overlay.classList.remove("hidden");
}

chkCriarPlanilha.addEventListener("change", () => {
  inputNomePlanilha.classList.toggle("hidden", !chkCriarPlanilha.checked);
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
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) overlay.classList.add("hidden");
});

inputArquivo.addEventListener("change", async () => {
  const file = inputArquivo.files[0];
  if (!file) return;
  arquivoNome.textContent = "Enviando...";
  const formData = new FormData();
  formData.append("arquivo", file);
  try {
    const r = await fetch("/api/import/upload", { method: "POST", body: formData });
    const data = await r.json();
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
      const job = await r.json();
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
    const data = await resp.json();
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
overlayComando.addEventListener("click", (e) => {
  if (e.target === overlayComando) overlayComando.classList.add("hidden");
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
    const data = await r.json();
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
    const data = await r.json();
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
    const data = await r.json();
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
    const data = await r.json();
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
      const job = await r.json();
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
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "Falha ao iniciar envio em massa.");
    iniciarPollingMassa(data.job_id);
  } catch (err) {
    mostrarErro(String(err));
    btnComandoEnviarMassa.disabled = false;
    btnComandoEnviarMassa.textContent = "Enviar";
  }
});

atualizarStatus();
