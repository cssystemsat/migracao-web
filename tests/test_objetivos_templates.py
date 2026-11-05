from contextlib import contextmanager
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.orm import sessionmaker

import app
import cliente_eventos_sql
import db_sql
import objetivos_sql
from models import Base, Cliente, ClienteEvento


class ObjetivosHierarquicosPersistenciaTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", future=True)
        event.listen(
            self.engine,
            "connect",
            lambda conexao, _: conexao.execute("PRAGMA foreign_keys=ON"),
        )
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(bind=self.engine, future=True, expire_on_commit=False)
        self.patcher = patch.object(db_sql, "SessionLocal", self.SessionLocal)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.addCleanup(self.engine.dispose)
        with self.SessionLocal() as sessao:
            sessao.add_all([
                Cliente(idcentral="obj-1", cliente="Cliente A"),
                Cliente(idcentral="obj-2", cliente="Cliente B"),
            ])
            sessao.commit()
            self.cliente_a = sessao.scalar(select(Cliente).where(Cliente.idcentral == "obj-1")).id
            self.cliente_b = sessao.scalar(select(Cliente).where(Cliente.idcentral == "obj-2")).id

    def test_copia_template_permanece_independente_e_reordena_itens(self):
        template = objetivos_sql.salvar_template("Vídeo Telemetria", [
            {"id": None, "texto": "Configuração da câmera", "feito": False},
            {"id": None, "texto": "Apontar a primeira câmera", "feito": False},
        ])
        objetivos_a = objetivos_sql.salvar_objetivos(self.cliente_a, [{
            "id": None,
            "nome": template["nome"],
            "feito": False,
            "origem_template_id": template["id"],
            "itens": [
                {"id": None, "texto": item["texto"], "feito": False}
                for item in template["itens"]
            ],
        }])
        objetivos_b = objetivos_sql.salvar_objetivos(self.cliente_b, [{
            "id": None,
            "nome": template["nome"],
            "feito": False,
            "origem_template_id": template["id"],
            "itens": [
                {"id": None, "texto": item["texto"], "feito": False}
                for item in template["itens"]
            ],
        }])

        objetivo_a = objetivos_a[0]
        objetivo_a["itens"][0]["texto"] = "Configuração especial do cliente A"
        objetivo_a["itens"][0]["feito"] = True
        objetivo_a["itens"].reverse()
        objetivo_a["itens"].append({
            "id": None,
            "texto": "Instalar câmera adicional",
            "feito": False,
        })
        atualizados = objetivos_sql.salvar_objetivos(self.cliente_a, objetivos_a)
        template_atual = objetivos_sql.listar_templates()[0]

        self.assertEqual(len(atualizados[0]["itens"]), 3)
        self.assertEqual(atualizados[0]["itens"][0]["texto"], "Apontar a primeira câmera")
        self.assertEqual(atualizados[0]["itens"][1]["texto"], "Configuração especial do cliente A")
        self.assertEqual(atualizados[0]["itens"][1]["feito"], True)
        self.assertEqual(len(objetivos_sql.listar_objetivos(self.cliente_b)[0]["itens"]), 2)
        self.assertEqual(template_atual["itens"][0]["texto"], "Configuração da câmera")
        self.assertEqual(objetivos_b[0]["itens"][0]["texto"], "Configuração da câmera")

    def test_progresso_do_objetivo_com_subatividades_e_estado_legado(self):
        objetivos = objetivos_sql.salvar_objetivos(self.cliente_a, [
            {
                "id": None,
                "nome": "Objetivo com etapas",
                "feito": False,
                "origem_template_id": None,
                "itens": [
                    {"id": None, "texto": "Etapa 1", "feito": True},
                    {"id": None, "texto": "Etapa 2", "feito": False},
                ],
            },
            {
                "id": None,
                "nome": "Objetivo legado",
                "feito": True,
                "origem_template_id": None,
                "itens": [],
            },
        ])

        self.assertFalse(objetivos[0]["feito"])
        self.assertTrue(objetivos[1]["feito"])
        objetivos[0]["itens"][1]["feito"] = True
        salvos = objetivos_sql.salvar_objetivos(self.cliente_a, objetivos)
        self.assertTrue(all(item["feito"] for item in salvos[0]["itens"]))
        self.assertFalse(salvos[0]["feito"])

    def test_exclusao_de_template_nao_remove_objetivos_do_cliente(self):
        template = objetivos_sql.salvar_template("Modelo", [])
        objetivos_sql.salvar_objetivos(self.cliente_a, [{
            "id": None,
            "nome": "Modelo",
            "feito": False,
            "origem_template_id": template["id"],
            "itens": [],
        }])
        objetivos_sql.excluir_template(template["id"])

        objetivo = objetivos_sql.listar_objetivos(self.cliente_a)[0]
        self.assertEqual(objetivo["nome"], "Modelo")
        self.assertIsNone(objetivo["origem_template_id"])


class MigracaoObjetivosLegadosTest(unittest.TestCase):
    def test_copia_objetivos_json_sem_apagar_formato_legacy(self):
        engine = create_engine("sqlite:///:memory:", future=True)
        with engine.begin() as conexao:
            conexao.execute(text(
                "CREATE TABLE clientes (id INTEGER PRIMARY KEY, objetivos_implantacao JSON NOT NULL)"
            ))
            conexao.execute(
                text("INSERT INTO clientes (id, objetivos_implantacao) VALUES (1, :objetivos)"),
                {"objetivos": '[{"id":"a","texto":"Treinar equipe","feito":true}]'},
            )
            caminho = (
                Path(__file__).parents[1]
                / "migrations"
                / "versions"
                / "0a9ef9c2b741_objetivos_implantacao_hierarquicos.py"
            )
            spec = importlib.util.spec_from_file_location("migration_objetivos", caminho)
            migration = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(migration)
            contexto = MigrationContext.configure(conexao)
            with Operations.context(contexto):
                migration.upgrade()
            registros = conexao.execute(
                text("SELECT nome, feito FROM cliente_objetivos WHERE cliente_id = 1")
            ).all()
            legado = conexao.execute(
                text("SELECT objetivos_implantacao FROM clientes WHERE id = 1")
            ).scalar_one()

        self.assertEqual(registros, [("Treinar equipe", 1)])
        self.assertIn("Treinar equipe", legado)
        engine.dispose()


class EventosMarcosTimelineTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine, tables=[Cliente.__table__, ClienteEvento.__table__])
        self.session_factory = sessionmaker(bind=self.engine, future=True)
        with self.session_factory() as sessao:
            cliente = Cliente(idcentral="timeline-test", cliente="Cliente de teste")
            sessao.add(cliente)
            sessao.flush()
            self.cliente_id = cliente.id
            sessao.add_all([
                ClienteEvento(
                    cliente_id=self.cliente_id, setor="Implantação",
                    titulo="Marco 1 concluído", descricao="", data="2026-11-05",
                    responsavel="", tag="", origem_tipo="marco", origem_id="marco-1",
                ),
                ClienteEvento(
                    cliente_id=self.cliente_id, setor="Implantação",
                    titulo="Marco 5 concluído", descricao="", data="2026-11-05",
                    responsavel="", tag="", origem_tipo="marco", origem_id="marco-5",
                ),
                ClienteEvento(
                    cliente_id=self.cliente_id, setor="Implantação",
                    titulo="Implantação concluída (5 marcos)", descricao="",
                    data="2026-11-05", responsavel="", tag="",
                    origem_tipo="implantacao", origem_id="concluido",
                ),
                ClienteEvento(
                    cliente_id=self.cliente_id, setor="Implantação",
                    titulo="Marco 5 concluído", descricao="", data="2026-11-05",
                    responsavel="", tag="",
                ),
                ClienteEvento(
                    cliente_id=self.cliente_id, setor="Implantação",
                    titulo="Marco 1 concluído", descricao="", data="2026-11-05",
                    responsavel="", tag="",
                ),
            ])
            sessao.commit()

    def tearDown(self):
        self.engine.dispose()

    @contextmanager
    def _sessao(self):
        sessao = self.session_factory()
        try:
            yield sessao
            sessao.commit()
        except Exception:
            sessao.rollback()
            raise
        finally:
            sessao.close()

    def test_reabrir_marco_remove_eventos_novos_e_legados(self):
        with patch.object(cliente_eventos_sql, "obter_sessao", self._sessao):
            removidos = cliente_eventos_sql.sincronizar_eventos_marcos(
                self.cliente_id,
                ["marco-1", "marco-2", "marco-3", "marco-4"],
                False,
            )

        self.assertTrue(removidos)
        with self.session_factory() as sessao:
            eventos = sessao.query(ClienteEvento).all()
        self.assertEqual(len(eventos), 2)
        self.assertEqual({evento.origem_id for evento in eventos if evento.origem_tipo == "marco"}, {"marco-1"})
        self.assertTrue(all(evento.titulo == "Marco 1 concluído" for evento in eventos))


class ObjetivosTemplatesPermissoesTest(unittest.TestCase):
    def setUp(self):
        self.cliente = {
            "id": 12,
            "idcentral": "997",
            "cliente": "Cliente de teste",
            "tem_implantacao": True,
            "objetivos_implantacao": [],
        }
        self.buscar = patch.object(app.clientes_sql, "buscar_cliente_por_id", return_value=self.cliente)
        self.listar = patch.object(objetivos_sql, "listar_templates", return_value=[])
        self.salvar = patch.object(objetivos_sql, "salvar_template", return_value={"id": 1, "nome": "Modelo", "itens": []})
        self.auditar = patch.object(app, "registrar_acao")
        for item in (self.buscar, self.listar, self.salvar, self.auditar):
            item.start()
            self.addCleanup(item.stop)
        self.client = app.app.test_client()

    def _login_com_perfil(self, perfil):
        with self.client.session_transaction() as sessao:
            sessao["app_ok"] = True
            sessao["app_usuario_perfil"] = perfil

    def test_analista_pode_listar_templates_mas_nao_gerenciar(self):
        self._login_com_perfil("analista")

        resposta_lista = self.client.get("/api/objetivos-templates")
        resposta_criacao = self.client.post(
            "/api/objetivos-templates",
            json={"nome": "Modelo", "itens": []},
        )

        self.assertEqual(resposta_lista.status_code, 200)
        self.assertEqual(resposta_criacao.status_code, 403)

    def test_administrador_pode_criar_template(self):
        self._login_com_perfil("adm")

        resposta = self.client.post(
            "/api/objetivos-templates",
            json={"nome": "Modelo", "itens": []},
        )

        self.assertEqual(resposta.status_code, 201)
        self.assertEqual(resposta.json["template"]["nome"], "Modelo")

    def test_analista_pode_gravar_objetivo_com_subatividades_validadas(self):
        self._login_com_perfil("analista")
        payload = {
            "objetivos": [{
                "id": "novo-objetivo",
                "nome": "Vídeo Telemetria",
                "feito": False,
                "origem_template_id": None,
                "itens": [{"id": "nova-etapa", "texto": "Configurar câmera", "feito": False}],
            }],
        }
        salvos = [{
            "id": 8,
            "nome": "Vídeo Telemetria",
            "feito": False,
            "origem_template_id": None,
            "ordem": 0,
            "itens": [{"id": 13, "texto": "Configurar câmera", "feito": False, "ordem": 0}],
        }]
        with patch.object(objetivos_sql, "salvar_objetivos", return_value=salvos) as salvar_objetivos:
            resposta = self.client.put(
                "/api/clientes/12/objetivos-implantacao-detalhados",
                json=payload,
            )

        self.assertEqual(resposta.status_code, 200)
        salvar_objetivos.assert_called_once_with(12, [{
            **payload["objetivos"][0],
            "prazo_dias": None,
            "concluido_em": "",
        }])

    def test_reabrir_objetivo_remove_evento_automatico_da_timeline(self):
        self._login_com_perfil("analista")
        anteriores = [{
            "id": 8,
            "nome": "Vídeo Telemetria",
            "feito": True,
            "concluido_em": "2026-11-05",
            "itens": [],
        }]
        salvos = [{**anteriores[0], "feito": False, "concluido_em": ""}]
        with (
            patch.object(objetivos_sql, "listar_objetivos", return_value=anteriores),
            patch.object(objetivos_sql, "salvar_objetivos", return_value=salvos),
            patch.object(app.cliente_eventos_sql, "sincronizar_eventos_objetivos_pendentes", return_value=True) as sincronizar_eventos,
            patch.object(app.cliente_eventos_sql, "recalcular_ultima_acao") as recalcular_ultima_acao,
        ):
            resposta = self.client.put(
                "/api/clientes/12/objetivos-implantacao-detalhados",
                json={"objetivos": [{
                    "id": 8,
                    "nome": "Vídeo Telemetria",
                    "feito": False,
                    "itens": [],
                }]},
            )

        self.assertEqual(resposta.status_code, 200)
        sincronizar_eventos.assert_called_once_with(
            12,
            salvos,
            titulos_legados=[],
        )
        recalcular_ultima_acao.assert_called_once_with(12)

    def test_carregar_objetivos_limpa_evento_antigo_de_objetivo_pendente(self):
        self._login_com_perfil("analista")
        pendentes = [{
            "id": 8,
            "nome": "Vídeo Telemetria",
            "feito": False,
            "itens": [],
        }]
        with (
            patch.object(objetivos_sql, "listar_objetivos", return_value=pendentes),
            patch.object(app.cliente_eventos_sql, "sincronizar_eventos_objetivos_pendentes", return_value=True) as sincronizar_eventos,
            patch.object(app.cliente_eventos_sql, "recalcular_ultima_acao") as recalcular_ultima_acao,
        ):
            resposta = self.client.get("/api/clientes/12/objetivos-implantacao-detalhados")

        self.assertEqual(resposta.status_code, 200)
        sincronizar_eventos.assert_called_once_with(
            12,
            pendentes,
            titulos_legados=(),
        )
        recalcular_ultima_acao.assert_called_once_with(12)

    def test_reabrir_marco_remove_evento_do_marco_e_da_implantacao_concluida(self):
        self._login_com_perfil("analista")
        self.cliente.update({
            "marcos_concluidos": ["marco-1", "marco-2", "marco-3", "marco-4", "marco-5"],
            "marcos_concluidos_em": {},
            "etapa": "concluido",
        })
        marcos_ativos = ["marco-1", "marco-2", "marco-3", "marco-4"]
        with (
            patch.object(app, "_marcos_concluidos_derivados", return_value=marcos_ativos),
            patch.object(app, "_etapa_a_partir_dos_marcos", return_value="marco-5"),
            patch.object(app.clientes_sql, "atualizar_cliente", return_value=self.cliente),
            patch.object(app.cliente_eventos_sql, "sincronizar_eventos_marcos", return_value=True) as sincronizar_eventos,
            patch.object(app.cliente_eventos_sql, "recalcular_ultima_acao") as recalcular_ultima_acao,
            patch.object(app, "registrar_acao"),
        ):
            resposta = self.client.put(
                "/api/clientes/12/marcos",
                json={
                    "itens_feitos": [],
                    "itens_extras": {},
                    "prioridades": [],
                    "concluidos_manual": marcos_ativos,
                },
            )

        self.assertEqual(resposta.status_code, 200)
        sincronizar_eventos.assert_called_once_with(12, marcos_ativos, False)
        recalcular_ultima_acao.assert_called_once_with(12)

    def test_rejeita_subatividade_vazia_sem_persistir(self):
        self._login_com_perfil("analista")
        with patch.object(objetivos_sql, "salvar_objetivos") as salvar_objetivos:
            resposta = self.client.put(
                "/api/clientes/12/objetivos-implantacao-detalhados",
                json={"objetivos": [{
                    "nome": "Vídeo Telemetria",
                    "itens": [{"texto": "  "}],
                }]},
            )

        self.assertEqual(resposta.status_code, 400)
        salvar_objetivos.assert_not_called()

    def test_visualizacao_nao_pode_gravar_objetivos(self):
        self._login_com_perfil("visualizacao")
        with patch.object(objetivos_sql, "salvar_objetivos") as salvar_objetivos:
            resposta = self.client.put(
                "/api/clientes/12/objetivos-implantacao-detalhados",
                json={"objetivos": []},
            )

        self.assertEqual(resposta.status_code, 403)
        salvar_objetivos.assert_not_called()


if __name__ == "__main__":
    unittest.main()
