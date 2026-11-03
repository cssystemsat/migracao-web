import unittest
from unittest.mock import patch

import app


class AtalhosExclusaoApiTest(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        with self.client.session_transaction() as sessao:
            sessao["app_ok"] = True
            sessao["app_usuario_perfil"] = "analista"

    @patch.object(app, "requisicao_padrao")
    @patch.object(app, "_token_para", return_value=("token-teste", None, 200))
    def test_lista_veiculos_com_cliente_e_id_do_rastreador(self, _token, requisicao):
        requisicao.return_value = [{
            "VehicleIntegrationCode": "VEIC-1",
            "Identification": "ABC1234",
            "ClientTradingName": "Cliente de teste",
            "IdTracker": "RSTR-9",
        }]

        resposta = self.client.post("/api/atalhos/listar/veiculo")

        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.json["registros"], [{
            "codigo": "VEIC-1",
            "nome": "ABC1234",
            "elegivel": True,
            "cliente": "Cliente de teste",
            "id_rastreador": "RSTR-9",
        }])
