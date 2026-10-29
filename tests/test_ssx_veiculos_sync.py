import unittest
from unittest.mock import Mock, patch

import migracao_status
import ssx_http
import ssx_veiculos_sync


class CalcularStatusComunicacaoTest(unittest.TestCase):
    def setUp(self):
        self.veiculos = [
            {"id": 1, "id_equipamento": "id-1", "codigo_integracao_rastreador_ssx": "codigo-1"},
            {"id": 2, "id_equipamento": "id-2", "codigo_integracao_rastreador_ssx": "codigo-2"},
            {"id": 3, "id_equipamento": "id-3", "codigo_integracao_rastreador_ssx": "codigo-3"},
            {"id": 4, "id_equipamento": "codigo-sem-id"},
        ]

    def test_compara_listas_por_id_tracker(self):
        resultado = ssx_veiculos_sync.calcular_status_comunicacao(
            self.veiculos,
            [
                {
                    "Tracker": "id-1",
                    "TrackerIntegrationCode": "codigo-diferente",
                }
            ],
            [
                {
                    "Tracker": "id-2",
                    "TrackerIntegrationCode": "outro-codigo",
                    "EventDate": "2026-10-28T10:00:00",
                },
                {"Tracker": "id-3", "EventDate": None},
            ],
        )

        self.assertEqual(resultado[1]["status"], "atualizado")
        self.assertEqual(resultado[2]["status"], "desatualizado")
        self.assertTrue(resultado[2]["confirma_migracao"])
        self.assertEqual(resultado[3]["status"], "desatualizado")
        self.assertFalse(resultado[3]["confirma_migracao"])
        self.assertEqual(resultado[4]["status"], "sem_dado")

    def test_usa_id_equipamento_da_ficha_em_vez_do_codigo_integracao(self):
        resultado = ssx_veiculos_sync.calcular_status_comunicacao(
            [self.veiculos[0]],
            [{"Tracker": "id-1", "TrackerIntegrationCode": "codigo-1"}],
            [],
        )

        self.assertEqual(resultado[1]["status"], "atualizado")

    def test_codigo_integracao_nao_e_usado_como_id_tracker(self):
        resultado = ssx_veiculos_sync.calcular_status_comunicacao(
            [self.veiculos[0]],
            [{"Tracker": "codigo-1"}],
            [],
        )

        self.assertEqual(resultado[1]["status"], "sem_dado")

    def test_veiculo_sem_id_de_rastreador_nao_e_encontrado_pela_placa(self):
        veiculo = {
            "id": 5,
            "veiculo": "SPB1C29",
            "id_equipamento": "",
            "codigo_integracao_rastreador_ssx": None,
        }
        resultado = ssx_veiculos_sync.calcular_status_comunicacao(
            [veiculo],
            [
                {
                    "Tracker": "id-sem-codigo",
                    "TrackerIntegrationCode": None,
                    "Plate": "spb1c29",
                    "EventDate": "2026-10-28T10:00:00",
                }
            ],
            [],
        )

        self.assertEqual(resultado[5]["status"], "sem_dado")
        self.assertFalse(resultado[5]["confirma_migracao"])

    def test_id_do_rastreador_vazio_nao_usa_codigo_de_integracao(self):
        veiculo = {
            "id": 7,
            "id_equipamento": "",
            "codigo_integracao_rastreador_ssx": "codigo-1",
        }
        resultado = ssx_veiculos_sync.calcular_status_comunicacao(
            [veiculo],
            [{"Tracker": "codigo-1", "EventDate": "2026-10-28T10:00:00"}],
            [],
        )

        self.assertEqual(resultado[7]["status"], "sem_dado")
        self.assertFalse(resultado[7]["confirma_migracao"])

    def test_id_do_rastreador_tem_precedencia_sobre_placa(self):
        veiculo = {"id": 6, "veiculo": "SPB1C29", "id_equipamento": "id-6"}
        resultado = ssx_veiculos_sync.calcular_status_comunicacao(
            [veiculo],
            [{"Tracker": "id-diferente", "Plate": "SPB1C29", "EventDate": "2026-10-28"}],
            [],
        )

        self.assertEqual(resultado[6]["status"], "sem_dado")


class CalcularDiffSincronizacaoTest(unittest.TestCase):
    def test_atualiza_equipamento_com_nome_do_modelo_ssx(self):
        diff = ssx_veiculos_sync.calcular_diff_sincronizacao(
            [
                {
                    "id": 10,
                    "cliente": "Cliente",
                    "veiculo": "ABC1D23",
                    "id_equipamento": "rastreador-1",
                    "codigo_integracao_rastreador_ssx": "codigo-1",
                    "equipamento": "",
                }
            ],
            [
                {
                    "TrackerIntegrationCode": "codigo-1",
                    "VehicleIntegrationCode": "veiculo-1",
                    "IdModelTracker": 7,
                    "LicensePlate": "ABC1D23",
                }
            ],
            [{"IdTrackerModel": 7, "TrackerModel": "Modelo SSX"}],
        )

        self.assertEqual(diff["a_atualizar"][0]["veiculo_id"], 10)
        self.assertEqual(diff["a_atualizar"][0]["campos"]["equipamento"], ("", "Modelo SSX"))

    def test_cria_veiculo_com_nome_do_modelo_ssx(self):
        diff = ssx_veiculos_sync.calcular_diff_sincronizacao(
            [],
            [
                {
                    "TrackerIntegrationCode": "codigo-1",
                    "VehicleIntegrationCode": "veiculo-1",
                    "IdModelTracker": 7,
                    "LicensePlate": "ABC1D23",
                }
            ],
            [{"IdTrackerModel": 7, "TrackerModel": "Modelo SSX"}],
        )

        self.assertEqual(diff["a_criar"][0]["campos"]["equipamento"], "Modelo SSX")

    def test_modelo_nao_resolvido_nao_apaga_equipamento_existente(self):
        diff = ssx_veiculos_sync.calcular_diff_sincronizacao(
            [
                {
                    "id": 10,
                    "cliente": "Cliente",
                    "veiculo": "ABC1D23",
                    "id_equipamento": "rastreador-1",
                    "codigo_integracao_rastreador_ssx": "codigo-1",
                    "codigo_integracao_veiculo_ssx": "veiculo-1",
                    "equipamento": "Modelo já salvo",
                }
            ],
            [
                {
                    "TrackerIntegrationCode": "codigo-1",
                    "VehicleIntegrationCode": "veiculo-1",
                    "IdModelTracker": 99,
                    "LicensePlate": "ABC1D23",
                }
            ],
            [{"IdTrackerModel": 7, "TrackerModel": "Outro modelo"}],
        )

        self.assertEqual(diff["a_atualizar"], [])
        self.assertEqual(diff["sem_mudanca"], 1)

    def test_casa_por_tracker_id_mesmo_sem_codigo_de_integracao(self):
        # Rastreador real, com IdTracker, mas TrackerIntegrationCode em branco
        # (campo opcional na SSX) — tem que casar pelo IdTracker e NUNCA virar
        # "a_criar" (duplicata) nem sobrar em "nao_cadastrados".
        diff = ssx_veiculos_sync.calcular_diff_sincronizacao(
            [
                {
                    "id": 20,
                    "cliente": "Cliente",
                    "veiculo": "ABC1D23",
                    "id_equipamento": "9999",
                    "equipamento": "",
                }
            ],
            [
                {
                    "IdTracker": "9999",
                    "TrackerIntegrationCode": None,
                    "VehicleIntegrationCode": "veiculo-1",
                    "IdModelTracker": 7,
                    "LicensePlate": "XXXYYY",
                }
            ],
            [{"IdTrackerModel": 7, "TrackerModel": "Modelo SSX"}],
        )

        self.assertEqual(diff["a_criar"], [])
        self.assertEqual(diff["nao_cadastrados"], [])
        self.assertEqual(diff["a_atualizar"][0]["veiculo_id"], 20)
        self.assertEqual(diff["a_atualizar"][0]["campos"]["veiculo"], ("ABC1D23", "XXXYYY"))

    def test_casa_por_tracker_id_tem_precedencia_sobre_codigo_de_integracao(self):
        # TrackerIntegrationCode (opcional/não confiável) aponta pra outra
        # linha local — o IdTracker (confiável) é quem decide.
        diff = ssx_veiculos_sync.calcular_diff_sincronizacao(
            [
                {"id": 21, "cliente": "Cliente", "veiculo": "AAA1111", "id_equipamento": "111", "equipamento": ""},
                {"id": 22, "cliente": "Cliente", "veiculo": "BBB2222", "id_equipamento": "222",
                 "codigo_integracao_rastreador_ssx": "111", "equipamento": ""},
            ],
            [{"IdTracker": "111", "TrackerIntegrationCode": "111", "LicensePlate": "AAA1111"}],
            [],
        )

        # Casou com a 21 (pelo IdTracker) — só atualiza o código de integração
        # informativo, que estava vazio. A 22 nunca entra em a_atualizar: o
        # TrackerIntegrationCode "111" que ela guarda não serve pra casar nada.
        self.assertEqual(diff["a_atualizar"], [
            {"veiculo_id": 21, "campos": {"codigo_integracao_rastreador_ssx": (None, "111")}},
        ])
        # Linha 22 (id_equipamento="222") não tinha correspondência nenhuma na
        # SSX enviada — fica como não cadastrada, nunca a 21.
        self.assertEqual(diff["nao_cadastrados"], [22])

    def test_veiculo_criado_a_partir_do_ssx_usa_tracker_id_como_id_equipamento(self):
        diff = ssx_veiculos_sync.calcular_diff_sincronizacao(
            [],
            [{"IdTracker": "9999", "TrackerIntegrationCode": None, "LicensePlate": "NOVOPLACA"}],
            [],
        )

        self.assertEqual(diff["a_criar"][0]["campos"]["id_equipamento"], "9999")

    def test_veiculo_sem_codigo_de_integracao_e_encontrado_pela_placa(self):
        diff = ssx_veiculos_sync.calcular_diff_sincronizacao(
            [
                {
                    "id": 11,
                    "cliente": "Jesat",
                    "veiculo": "SPB1C29",
                    "id_equipamento": "",
                    "equipamento": "",
                }
            ],
            [
                {
                    "TrackerIntegrationCode": None,
                    "VehicleIntegrationCode": "codigo-veiculo-ssx",
                    "IdModelTracker": 7,
                    "LicensePlate": "spb1c29",
                }
            ],
            [{"IdTrackerModel": 7, "TrackerModel": "Modelo SSX"}],
        )

        self.assertEqual(diff["a_criar"], [])
        self.assertEqual(diff["a_atualizar"][0]["veiculo_id"], 11)
        self.assertEqual(diff["a_atualizar"][0]["campos"]["equipamento"], ("", "Modelo SSX"))


class ContagemMigracaoVeiculoTest(unittest.TestCase):
    def test_veiculo_sem_id_de_rastreador_fica_com_status_sem_rastreador(self):
        self.assertEqual(
            migracao_status.normalizar_status_veiculo("Aguardando", ""),
            "Sem rastreador",
        )

    def test_status_sem_rastreador_sobrepoe_migrado_quando_nao_ha_id(self):
        self.assertEqual(
            migracao_status.normalizar_status_veiculo("Migrado", ""),
            "Sem rastreador",
        )

    def test_confirmacao_ssx_antiga_e_removida_quando_nao_ha_id(self):
        self.assertEqual(
            migracao_status.normalizar_confirmacao_sem_rastreador(
                True,
                "2026-10-28 10:00:00",
                "",
            ),
            (False, None),
        )

    def test_confirmacao_ssx_e_preservada_quando_ha_id(self):
        self.assertEqual(
            migracao_status.normalizar_confirmacao_sem_rastreador(
                True,
                "2026-10-28 10:00:00",
                "rastreador-1",
            ),
            (True, "2026-10-28 10:00:00"),
        )

    def test_veiculo_cancelado_permanece_cancelado_sem_rastreador(self):
        self.assertEqual(
            migracao_status.normalizar_status_veiculo("Cancelado", ""),
            "Cancelado",
        )

    def test_preencher_id_de_rastreador_reativa_veiculo_sem_rastreador(self):
        self.assertEqual(
            migracao_status.normalizar_status_veiculo("Sem rastreador", "tracker-1"),
            "Aguardando",
        )

    def test_cancelado_e_sem_rastreador_ficam_fora_do_resumo(self):
        resumo = migracao_status.calcular_resumo_modelos([
            ("Modelo A", "Migrado"),
            ("Modelo A", "Aguardando"),
            ("Modelo B", "Cancelado"),
            ("Modelo C", "Sem rastreador"),
        ])

        self.assertEqual(resumo[-1]["total"], 2)
        self.assertEqual(resumo[-1]["comunicou"], 1)
        self.assertEqual([linha["modelo"] for linha in resumo], ["Modelo A", "Total"])

    def test_status_excluidos_nao_contam_para_o_progresso(self):
        self.assertFalse(migracao_status.veiculo_conta_na_migracao("Cancelado"))
        self.assertFalse(migracao_status.veiculo_conta_na_migracao("Sem rastreador"))
        self.assertTrue(migracao_status.veiculo_conta_na_migracao("Migrado"))


class SsxHttpTest(unittest.TestCase):
    @patch("ssx_http.time.sleep")
    @patch("ssx_http.requests.post")
    def test_repete_timeout_e_retorna_resposta(self, post, _sleep):
        response = Mock()
        response.status_code = 200
        response.content = b'{"ok": true}'
        response.json.return_value = {"ok": True}
        post.side_effect = [ssx_http.requests.Timeout("timeout"), response]

        resultado = ssx_http.post_json(
            "https://ssx.invalid/list",
            [],
            {},
            timeout=120,
            retries=1,
        )

        self.assertEqual(resultado, {"ok": True})
        self.assertEqual(post.call_count, 2)
        self.assertEqual(post.call_args.kwargs["timeout"], 120)

    @patch("ssx_http.time.sleep")
    @patch("ssx_http.requests.post")
    def test_repete_gateway_transitorio(self, post, _sleep):
        retry_response = Mock()
        retry_response.status_code = 503
        response = Mock()
        response.status_code = 200
        response.content = b"[]"
        response.json.return_value = []
        post.side_effect = [retry_response, response]

        self.assertEqual(ssx_http.post_json("https://ssx.invalid/list", [], {}, retries=1), [])
        self.assertEqual(post.call_count, 2)

    @patch("ssx_http.requests.post")
    def test_nao_repete_erro_http_nao_transitorio(self, post):
        response = Mock()
        response.status_code = 400
        response.raise_for_status.side_effect = ssx_http.requests.HTTPError("bad request")
        post.return_value = response

        with self.assertRaises(ssx_http.requests.HTTPError):
            ssx_http.post_json("https://ssx.invalid/list", [], {}, retries=2)

        self.assertEqual(post.call_count, 1)


if __name__ == "__main__":
    unittest.main()
