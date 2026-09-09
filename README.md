# bambu-studio-mcp

Servidor **MCP (Model Context Protocol)** que integra o **Bambu Studio** e impressoras **Bambu Lab** ao **Claude** (Claude Desktop e Claude Code). Funciona em Windows, macOS e Linux — instale em quantos desktops quiser.

## O que o Claude passa a conseguir fazer

| Ferramenta | O que faz |
|---|---|
| `bambu_check_setup` | Diagnóstico da instalação (use primeiro em cada desktop novo) |
| `bambu_status` | Status da impressora: progresso, temperaturas, camadas, AMS/filamentos |
| `bambu_print_control` | Pausar / retomar / cancelar a impressão |
| `bambu_start_print` | Iniciar impressão de um `.gcode.3mf` que está no cartão SD |
| `bambu_send_gcode` | Enviar G-code direto (temperaturas, fans, home etc.) |
| `bambu_list_files` | Listar arquivos do SD da impressora (via FTPS) |
| `bambu_upload_file` | Enviar um arquivo local para o SD da impressora |
| `bambu_slice` | Fatiar um projeto `.3mf` pela CLI do Bambu Studio, gerando `.gcode.3mf` |
| `bambu_open_in_studio` | Abrir um arquivo (ou o app) no Bambu Studio local |

Fluxo típico: `bambu_slice` → `bambu_upload_file` → `bambu_start_print` → `bambu_status`.

## Pré-requisitos

1. **Node.js 18+** — <https://nodejs.org>
2. **Bambu Studio** instalado (apenas para as ferramentas de fatiamento/abrir app; as de impressora funcionam sem ele)
3. **Impressora em modo LAN acessível na rede** (para as ferramentas de impressora):
   - **IP** da impressora: tela da impressora → Configurações → WLAN
   - **Access Code**: mesma tela (LAN Only Mode não precisa estar ativado — o Access Code funciona mesmo com a nuvem ligada, desde que "LAN Mode Liveview/acesso" esteja habilitado)
   - **Número de série (SN)**: tela da impressora → Configurações → Dispositivo, ou etiqueta na traseira

## Instalação (repita em cada desktop)

1. Clone o repositório:

```bash
git clone https://github.com/naderfilho/mcp.yuri.git
```

2. Instale as dependências:

```bash
cd mcp.yuri && npm install
```

3. Registre o servidor no cliente Claude (abaixo).

### Claude Code (CLI / app desktop, recomendado)

```bash
claude mcp add bambu --scope user -e BAMBU_PRINTER_IP=192.168.1.50 -e BAMBU_ACCESS_CODE=12345678 -e BAMBU_SERIAL=01S00A000000000 -- node "C:/caminho/para/mcp.yuri/src/index.js"
```

`--scope user` deixa o servidor disponível em todos os projetos daquele desktop.

### Claude Desktop (app de chat)

Edite o arquivo de configuração:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bambu": {
      "command": "node",
      "args": ["C:/caminho/para/mcp.yuri/src/index.js"],
      "env": {
        "BAMBU_PRINTER_IP": "192.168.1.50",
        "BAMBU_ACCESS_CODE": "12345678",
        "BAMBU_SERIAL": "01S00A000000000",
        "BAMBU_STUDIO_PATH": "C:/Program Files/Bambu Studio/bambu-studio.exe"
      }
    }
  }
}
```

Reinicie o Claude Desktop depois de salvar. Um exemplo pronto está em [`examples/claude_desktop_config.example.json`](examples/claude_desktop_config.example.json).

4. No Claude, peça: **"rode bambu_check_setup"** — ele confirma o que está funcionando naquele desktop.

## Variáveis de ambiente

| Variável | Obrigatória? | Descrição |
|---|---|---|
| `BAMBU_PRINTER_IP` | Para ferramentas de impressora | IP local da impressora |
| `BAMBU_ACCESS_CODE` | Para ferramentas de impressora | Access Code do LAN mode |
| `BAMBU_SERIAL` | Para ferramentas de impressora | Número de série da impressora |
| `BAMBU_STUDIO_PATH` | Não | Caminho do executável do Bambu Studio (auto-detectado nos locais padrão) |

Todas podem também ser passadas por chamada (`ip`, `access_code`, `serial`), útil para controlar **mais de uma impressora** a partir do mesmo desktop.

## Dicas para múltiplos desktops

- O servidor roda **localmente via stdio** em cada máquina — nada é exposto na internet; a comunicação com a impressora fica restrita à rede local (MQTT 8883 + FTPS 990).
- Cada desktop pode ter caminho de Bambu Studio e impressora diferentes: basta ajustar as variáveis `env` daquele desktop.
- Se publicar no GitHub, atualizar todos os desktops vira um `git pull && npm install`.
- Impressoras A1/P1 têm firmware mais restrito em algumas chamadas FTPS/MQTT; X1/X1C/P1S com firmware atualizado funcionam plenamente em LAN mode.

## Como funciona (protocolo)

- **MCP**: transporte stdio, SDK oficial `@modelcontextprotocol/sdk` — compatível com qualquer host MCP.
- **Impressora**: MQTT sobre TLS (`mqtts://IP:8883`, usuário `bblp`, senha = Access Code), tópicos `device/{serial}/request|report`; arquivos via FTPS implícito na porta 990.
- **Bambu Studio**: CLI (`--slice` / `--export-3mf`) para fatiar e abertura do app para edição visual.

## Solução de problemas

- **"Falha na conexão MQTT"** — confira IP e Access Code; o Access Code muda se a impressora for resetada ou trocar de rede.
- **"não recebeu dados da impressora"** — o número de série (`BAMBU_SERIAL`) está errado.
- **Fatiamento falha com STL** — a CLI precisa de perfis; abra o STL no Bambu Studio, configure impressora/filamento/processo e salve como projeto `.3mf`, então fatie o `.3mf`.
- **Firewall** — permita saída para as portas 8883 (MQTT) e 990 (FTPS) na rede local.
