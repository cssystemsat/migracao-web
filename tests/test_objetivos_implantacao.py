import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

import app
import clientes_sql
from models import Base, Cliente


class ObjetivosImplantacaoApiTest(unittest.TestCase):
    def setUp(self):
        self.cliente = {
            "id": 12,
            "idcentral": "997",
            "cliente": "Cliente de teste",
            "tem_implantacao": True,
            "objetivos_implantacao": [],
        }
        self.buscar = patch.object(app.clientes_sql, "buscar_cliente_por_id", return_value=self.cliente)
        self.atualizar = patch.object(app.clientes_sql, "atualizar_cliente", side_effect=self.atualizar_cliente)
        self.auditar = patch.object(app, "registrar_acao")
        self.buscar.start()
        self.atualizar.start()
        self.auditar.start()
        self.addCleanup(self.buscar.stop)
        self.addCleanup(self.atualizar.stop)
        self.addCleanup(self.auditar.stop)
        self.client = app.app.test_client()
        with self.client.session_transaction() as sessao:
            sessao["app_ok"] = True
            sessao["app_usuario_perfil"] = "analista"

    def atualizar_cliente(self, cliente_id, campos):
        if cliente_id != self.cliente["id"]:
            return None
        self.cliente.update(campos)
        return self.cliente

    def test_salva_objetivos_e_estado_de_conclusao(self):
        objetivos = [
            {"id": "objetivo-1", "texto": "Configurar os veículos", "feito": True},
            {"id": "objetivo-2", "texto": "Treinar a equipe", "feito": False},
        ]
        resposta = self.client.put(
            "/api/clientes/12/objetivos-implantacao",
            json={"objetivos": objetivos},
        )

        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.json["objetivos"], objetivos)
        self.assertEqual(self.cliente["objetivos_implantacao"], objetivos)

    def test_rejeita_ids_duplicados_sem_salvar(self):
        resposta = self.client.put(
            "/api/clientes/12/objetivos-implantacao",
            json={"objetivos": [
                {"id": "repetido", "texto": "Primeiro"},
                {"id": "repetido", "texto": "Segundo"},
            ]},
        )

        self.assertEqual(resposta.status_code, 400)
        self.assertEqual(self.cliente["objetivos_implantacao"], [])

    def test_rejeita_cliente_sem_implantacao(self):
        self.cliente["tem_implantacao"] = False
        resposta = self.client.put(
            "/api/clientes/12/objetivos-implantacao",
            json={"objetivos": []},
        )

        self.assertEqual(resposta.status_code, 400)

    def test_objetivos_sao_persistidos_e_serializados_pelo_modelo(self):
        engine = create_engine("sqlite:///:memory:", future=True)
        Base.metadata.create_all(engine, tables=[Cliente.__table__])
        objetivos = [{"id": "objetivo-1", "texto": "Configurar os veículos", "feito": True}]
        try:
            with Session(engine) as sessao:
                cliente = Cliente(idcentral="998", cliente="Cliente de teste", objetivos_implantacao=objetivos)
                sessao.add(cliente)
                sessao.commit()
                salvo = sessao.get(Cliente, cliente.id)
                self.assertEqual(clientes_sql._cliente_para_dict(salvo)["objetivos_implantacao"], objetivos)
        finally:
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
