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

async function autenticarComCampos() {
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
  autenticarComCampos();
});

el("btn-logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  aplicarEstadoAuth(false);
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
  await autenticarComCampos();
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
      await autenticarComCampos();
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
  const headers = ["Nome", "CS", "Plataforma de origem", "Quantidade de Clientes", "Quantidade de Placas", "Porcentagem da migração"];
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
    td.textContent = "Nenhum cliente cadastrado ainda. Adicione em \"Gerenciar logins\".";
    td.style.color = "#6b7280";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  clientes.forEach((c) => {
    const tr = document.createElement("tr");
    tr.className = "linha-clicavel";
    tr.addEventListener("click", () => abrirModalMigracao(c));
    [c.nome, c.cs, c.plataforma_origem, c.qtd_clientes, c.qtd_placas, `${c.percentual_migracao}%`].forEach((v) => {
      const td = document.createElement("td");
      td.textContent = v === null || v === undefined || v === "" ? "-" : String(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  setSaida(table);
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

  const r = await fetch(`/api/import/params/${tipo}`);
  const data = await r.json();
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

  const logContainer = document.createElement("div");
  setSaida(logContainer);

  try {
    const resp = await fetch("/api/import/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo: estado.importTipo, file_id: estado.fileId, mapping }),
    });

    if (!resp.ok) {
      const data = await resp.json();
      throw new Error(data.error || "Falha ao iniciar importação.");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let resumo = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const linhas = buffer.split("\n");
      buffer = linhas.pop();
      for (const linha of linhas) {
        if (!linha.trim()) continue;
        const evento = JSON.parse(linha);
        if (evento.type === "progress") {
          progressoBar.style.width = evento.pct + "%";
          progressoPct.textContent = evento.pct + "%";
          progressoStatus.textContent = `Processando ${evento.atual} de ${evento.total} (sucessos: ${evento.sucessos}, erros: ${evento.erros})`;
        } else if (evento.type === "log") {
          const linhaLog = document.createElement("div");
          linhaLog.className = "log-linha";
          linhaLog.textContent = evento.message;
          logContainer.appendChild(linhaLog);
        } else if (evento.type === "done") {
          resumo = evento;
        }
      }
    }

    if (resumo) {
      const div = document.createElement("div");
      div.className = "resumo-final";
      div.textContent = `Concluído! Sucessos: ${resumo.sucessos} | Erros: ${resumo.erros}`;
      logContainer.appendChild(div);
    }

    overlay.classList.add("hidden");
  } catch (err) {
    mostrarErro(String(err));
    overlay.classList.add("hidden");
  } finally {
    btnIniciarImport.disabled = false;
    btnIniciarImport.textContent = "Iniciar Importação";
  }
});

atualizarStatus();
