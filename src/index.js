#!/usr/bin/env node
/**
 * bambu-studio-mcp — Servidor MCP para integrar o Bambu Studio e
 * impressoras Bambu Lab (LAN mode) ao Claude.
 *
 * Transporte: stdio (funciona com Claude Desktop, Claude Code e qualquer host MCP).
 *
 * Configuração via variáveis de ambiente (todas opcionais; ferramentas que
 * precisarem de algo ausente retornam uma mensagem explicando o que falta):
 *   BAMBU_PRINTER_IP    - IP da impressora na rede local (ex.: 192.168.1.50)
 *   BAMBU_ACCESS_CODE   - Access Code do LAN mode (tela da impressora > Configurações > WLAN)
 *   BAMBU_SERIAL        - Número de série da impressora (ex.: 01S00A000000000)
 *   BAMBU_STUDIO_PATH   - Caminho do executável do Bambu Studio (auto-detectado se omitido)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mqtt from "mqtt";
import * as ftp from "basic-ftp";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

function printerConfig(overrides = {}) {
  const ip = overrides.ip || process.env.BAMBU_PRINTER_IP;
  const accessCode = overrides.access_code || process.env.BAMBU_ACCESS_CODE;
  const serial = overrides.serial || process.env.BAMBU_SERIAL;
  const missing = [];
  if (!ip) missing.push("BAMBU_PRINTER_IP");
  if (!accessCode) missing.push("BAMBU_ACCESS_CODE");
  if (!serial) missing.push("BAMBU_SERIAL");
  if (missing.length > 0) {
    throw new Error(
      `Configuração da impressora incompleta. Defina as variáveis de ambiente: ${missing.join(", ")} ` +
        `(ou passe ip/access_code/serial como parâmetros da ferramenta). ` +
        `O Access Code fica na tela da impressora em Configurações > WLAN (LAN mode).`
    );
  }
  return { ip, accessCode, serial };
}

const BAMBU_STUDIO_CANDIDATES = [
  process.env.BAMBU_STUDIO_PATH,
  // Windows
  "C:\\Program Files\\Bambu Studio\\bambu-studio.exe",
  "C:\\Program Files (x86)\\Bambu Studio\\bambu-studio.exe",
  path.join(os.homedir(), "AppData", "Local", "Programs", "BambuStudio", "bambu-studio.exe"),
  path.join(os.homedir(), "AppData", "Local", "Programs", "Bambu Studio", "bambu-studio.exe"),
  // macOS
  "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
  // Linux (AppImage costuma variar; flatpak abaixo)
  "/usr/bin/bambu-studio",
  "/var/lib/flatpak/exports/bin/com.bambulab.BambuStudio",
].filter(Boolean);

function findBambuStudio() {
  for (const candidate of BAMBU_STUDIO_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// MQTT (LAN mode) — porta 8883, usuário "bblp", senha = Access Code
// ---------------------------------------------------------------------------

function mqttConnect(cfg) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtts://${cfg.ip}:8883`, {
      username: "bblp",
      password: cfg.accessCode,
      rejectUnauthorized: false, // certificado autoassinado da impressora
      connectTimeout: 10_000,
      reconnectPeriod: 0,
    });
    const timer = setTimeout(() => {
      client.end(true);
      reject(new Error(`Timeout ao conectar em mqtts://${cfg.ip}:8883. Verifique IP, LAN mode e rede.`));
    }, 12_000);
    client.once("connect", () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once("error", (err) => {
      clearTimeout(timer);
      client.end(true);
      reject(new Error(`Falha na conexão MQTT com a impressora: ${err.message}. Confira o Access Code.`));
    });
  });
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

/** Conecta, pede um "pushall" e agrega mensagens de report por alguns segundos. */
async function fetchPrinterState(cfg, waitMs = 6000) {
  const client = await mqttConnect(cfg);
  const reportTopic = `device/${cfg.serial}/report`;
  const requestTopic = `device/${cfg.serial}/request`;
  const state = {};
  let gotPrintData = false;

  try {
    await new Promise((resolve, reject) => {
      client.subscribe(reportTopic, (err) => (err ? reject(err) : resolve()));
    });
    client.publish(
      requestTopic,
      JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } })
    );
    await new Promise((resolve) => {
      const done = setTimeout(resolve, waitMs);
      client.on("message", (_topic, payload) => {
        try {
          const msg = JSON.parse(payload.toString());
          deepMerge(state, msg);
          if (msg.print && (msg.print.nozzle_temper !== undefined || msg.print.gcode_state)) {
            gotPrintData = true;
            // dá um tempinho extra para chegar o resto e encerra
            clearTimeout(done);
            setTimeout(resolve, 1200);
          }
        } catch {
          /* mensagem não-JSON, ignora */
        }
      });
    });
  } finally {
    client.end(true);
  }

  if (!gotPrintData && Object.keys(state).length === 0) {
    throw new Error(
      "Conectou via MQTT mas não recebeu dados da impressora. Confira o número de série (BAMBU_SERIAL)."
    );
  }
  return state;
}

/** Publica um comando no tópico request e aguarda brevemente. */
async function sendPrinterCommand(cfg, payload) {
  const client = await mqttConnect(cfg);
  try {
    await new Promise((resolve, reject) => {
      client.publish(
        `device/${cfg.serial}/request`,
        JSON.stringify(payload),
        { qos: 1 },
        (err) => (err ? reject(err) : resolve())
      );
    });
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    client.end(true);
  }
}

const GCODE_STATES_PT = {
  IDLE: "ociosa",
  RUNNING: "imprimindo",
  PAUSE: "pausada",
  FINISH: "impressão concluída",
  FAILED: "falhou",
  PREPARE: "preparando",
  SLICING: "fatiando",
};

function summarizeState(state) {
  const p = state.print || {};
  const lines = [];
  const gs = p.gcode_state || "desconhecido";
  lines.push(`Estado: ${gs}${GCODE_STATES_PT[gs] ? ` (${GCODE_STATES_PT[gs]})` : ""}`);
  if (p.subtask_name) lines.push(`Trabalho: ${p.subtask_name}`);
  if (p.mc_percent !== undefined) lines.push(`Progresso: ${p.mc_percent}%`);
  if (p.mc_remaining_time !== undefined) {
    const h = Math.floor(p.mc_remaining_time / 60);
    const m = p.mc_remaining_time % 60;
    lines.push(`Tempo restante: ${h}h ${m}min`);
  }
  if (p.layer_num !== undefined && p.total_layer_num !== undefined) {
    lines.push(`Camada: ${p.layer_num}/${p.total_layer_num}`);
  }
  if (p.nozzle_temper !== undefined) {
    lines.push(`Bico: ${p.nozzle_temper}°C (alvo ${p.nozzle_target_temper ?? "-"}°C)`);
  }
  if (p.bed_temper !== undefined) {
    lines.push(`Mesa: ${p.bed_temper}°C (alvo ${p.bed_target_temper ?? "-"}°C)`);
  }
  if (p.chamber_temper !== undefined) lines.push(`Câmara: ${p.chamber_temper}°C`);
  if (p.cooling_fan_speed !== undefined) lines.push(`Fan da peça: ${p.cooling_fan_speed}`);
  if (p.spd_lvl !== undefined) {
    const spd = { 1: "silencioso", 2: "padrão", 3: "sport", 4: "ludicrous" }[p.spd_lvl] || p.spd_lvl;
    lines.push(`Velocidade: ${spd}`);
  }
  if (p.wifi_signal) lines.push(`Sinal Wi-Fi: ${p.wifi_signal}`);
  if (p.ams && Array.isArray(p.ams.ams)) {
    for (const unit of p.ams.ams) {
      const trays = (unit.tray || [])
        .map((t) => {
          const type = t.tray_type || "vazio";
          const color = t.tray_color ? ` #${t.tray_color}` : "";
          return `slot ${Number(t.id) + 1}: ${type}${color}`;
        })
        .join(", ");
      lines.push(`AMS ${Number(unit.id) + 1}: ${trays}`);
    }
  }
  if (p.print_error !== undefined && p.print_error !== 0) {
    lines.push(`⚠️ Código de erro: ${p.print_error}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// FTPS (cartão SD da impressora) — porta 990, TLS implícito
// ---------------------------------------------------------------------------

async function ftpsClient(cfg) {
  const client = new ftp.Client(20_000);
  await client.access({
    host: cfg.ip,
    port: 990,
    user: "bblp",
    password: cfg.accessCode,
    secure: "implicit",
    secureOptions: { rejectUnauthorized: false },
  });
  return client;
}

// ---------------------------------------------------------------------------
// Helpers de resposta
// ---------------------------------------------------------------------------

const text = (s) => ({ content: [{ type: "text", text: s }] });
const errText = (e) => ({
  content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

const printerOverrideParams = {
  ip: z.string().optional().describe("IP da impressora (sobrepõe BAMBU_PRINTER_IP)"),
  access_code: z.string().optional().describe("Access Code do LAN mode (sobrepõe BAMBU_ACCESS_CODE)"),
  serial: z.string().optional().describe("Número de série (sobrepõe BAMBU_SERIAL)"),
};

// ---------------------------------------------------------------------------
// Servidor MCP
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "bambu-studio-mcp",
  version: "1.0.0",
});

// --- Impressora: status -----------------------------------------------------

server.registerTool(
  "bambu_status",
  {
    title: "Status da impressora Bambu Lab",
    description:
      "Consulta o status da impressora Bambu Lab via MQTT (LAN mode): estado da impressão, progresso, " +
      "temperaturas (bico/mesa/câmara), camadas, AMS e filamentos carregados. " +
      "Use raw=true para receber o JSON completo do relatório.",
    inputSchema: {
      ...printerOverrideParams,
      raw: z.boolean().optional().describe("Se true, retorna o JSON bruto completo do estado"),
    },
  },
  async (args) => {
    try {
      const cfg = printerConfig(args);
      const state = await fetchPrinterState(cfg);
      if (args.raw) return text(JSON.stringify(state, null, 2));
      return text(summarizeState(state));
    } catch (e) {
      return errText(e);
    }
  }
);

// --- Impressora: pausar/retomar/parar --------------------------------------

server.registerTool(
  "bambu_print_control",
  {
    title: "Controlar impressão (pausar/retomar/parar)",
    description:
      "Pausa, retoma ou cancela a impressão atual da impressora Bambu Lab. " +
      "ATENÇÃO: 'stop' cancela a impressão em andamento de forma irreversível.",
    inputSchema: {
      ...printerOverrideParams,
      action: z.enum(["pause", "resume", "stop"]).describe("Ação: pause, resume ou stop (cancelar)"),
    },
  },
  async (args) => {
    try {
      const cfg = printerConfig(args);
      await sendPrinterCommand(cfg, {
        print: { sequence_id: "0", command: args.action, param: "" },
      });
      const pt = { pause: "pausada", resume: "retomada", stop: "cancelada" }[args.action];
      return text(`Comando enviado: impressão ${pt}. Use bambu_status para confirmar.`);
    } catch (e) {
      return errText(e);
    }
  }
);

// --- Impressora: iniciar impressão de arquivo no SD -------------------------

server.registerTool(
  "bambu_start_print",
  {
    title: "Iniciar impressão de arquivo no SD",
    description:
      "Inicia a impressão de um arquivo .gcode.3mf que já está no cartão SD da impressora " +
      "(use bambu_upload_file antes, se necessário, e bambu_list_files para ver o que há no SD). " +
      "Por padrão imprime a placa 1 com nivelamento de mesa.",
    inputSchema: {
      ...printerOverrideParams,
      filename: z
        .string()
        .describe("Nome do arquivo no SD, ex.: 'modelo.gcode.3mf' (caminho relativo à raiz do SD)"),
      plate: z.number().int().min(1).optional().describe("Número da placa a imprimir (padrão 1)"),
      use_ams: z.boolean().optional().describe("Usar AMS (padrão true)"),
      bed_leveling: z.boolean().optional().describe("Nivelar a mesa antes (padrão true)"),
      timelapse: z.boolean().optional().describe("Gravar timelapse (padrão false)"),
    },
  },
  async (args) => {
    try {
      const cfg = printerConfig(args);
      const plate = args.plate ?? 1;
      const file = args.filename.replace(/^\/+/, "");
      await sendPrinterCommand(cfg, {
        print: {
          sequence_id: "0",
          command: "project_file",
          param: `Metadata/plate_${plate}.gcode`,
          url: `file:///sdcard/${file}`,
          subtask_name: path.basename(file),
          use_ams: args.use_ams ?? true,
          bed_leveling: args.bed_leveling ?? true,
          timelapse: args.timelapse ?? false,
          flow_cali: false,
          vibration_cali: false,
          layer_inspect: true,
          subtask_id: "0",
          task_id: "0",
          project_id: "0",
          profile_id: "0",
        },
      });
      return text(
        `Comando de impressão enviado para '${file}' (placa ${plate}). ` +
          `Use bambu_status para acompanhar. Se nada acontecer, confirme que o arquivo é um .gcode.3mf fatiado.`
      );
    } catch (e) {
      return errText(e);
    }
  }
);

// --- Impressora: enviar G-code ---------------------------------------------

server.registerTool(
  "bambu_send_gcode",
  {
    title: "Enviar linha(s) de G-code",
    description:
      "Envia G-code diretamente para a impressora (LAN mode). Útil para ajustar temperaturas " +
      "(M104/M140), fans (M106), mover eixos (G28/G0), LED, etc. Use com cautela durante impressões.",
    inputSchema: {
      ...printerOverrideParams,
      gcode: z.string().describe("G-code a enviar; várias linhas separadas por \\n. Ex.: 'M104 S220'"),
    },
  },
  async (args) => {
    try {
      const cfg = printerConfig(args);
      await sendPrinterCommand(cfg, {
        print: { sequence_id: "0", command: "gcode_line", param: args.gcode + "\n" },
      });
      return text(`G-code enviado:\n${args.gcode}`);
    } catch (e) {
      return errText(e);
    }
  }
);

// --- Impressora: arquivos no SD (FTPS) --------------------------------------

server.registerTool(
  "bambu_list_files",
  {
    title: "Listar arquivos do SD da impressora",
    description:
      "Lista arquivos do cartão SD da impressora Bambu Lab via FTPS. " +
      "Diretórios úteis: '/' (raiz, onde ficam os .gcode.3mf enviados), '/timelapse', '/cache'.",
    inputSchema: {
      ...printerOverrideParams,
      dir: z.string().optional().describe("Diretório a listar (padrão '/')"),
    },
  },
  async (args) => {
    let client;
    try {
      const cfg = printerConfig(args);
      client = await ftpsClient(cfg);
      const list = await client.list(args.dir || "/");
      if (list.length === 0) return text("(diretório vazio)");
      const lines = list.map((f) => {
        const kind = f.isDirectory ? "[DIR] " : "";
        const size = f.isDirectory ? "" : ` (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
        return `${kind}${f.name}${size}`;
      });
      return text(lines.join("\n"));
    } catch (e) {
      return errText(e);
    } finally {
      client?.close();
    }
  }
);

server.registerTool(
  "bambu_upload_file",
  {
    title: "Enviar arquivo para o SD da impressora",
    description:
      "Envia um arquivo local (normalmente um .gcode.3mf fatiado) para o cartão SD da impressora via FTPS. " +
      "Depois use bambu_start_print para imprimi-lo.",
    inputSchema: {
      ...printerOverrideParams,
      local_path: z.string().describe("Caminho local do arquivo a enviar"),
      remote_name: z
        .string()
        .optional()
        .describe("Nome do arquivo no SD (padrão: mesmo nome do arquivo local)"),
    },
  },
  async (args) => {
    let client;
    try {
      const cfg = printerConfig(args);
      if (!existsSync(args.local_path)) {
        throw new Error(`Arquivo local não encontrado: ${args.local_path}`);
      }
      const remote = (args.remote_name || path.basename(args.local_path)).replace(/^\/+/, "");
      client = await ftpsClient(cfg);
      await client.uploadFrom(args.local_path, `/${remote}`);
      const stat = await fs.stat(args.local_path);
      return text(
        `Enviado: ${args.local_path} -> SD:/${remote} (${(stat.size / 1024 / 1024).toFixed(2)} MB). ` +
          `Use bambu_start_print com filename='${remote}' para imprimir.`
      );
    } catch (e) {
      return errText(e);
    } finally {
      client?.close();
    }
  }
);

// --- Bambu Studio: fatiar via CLI -------------------------------------------

server.registerTool(
  "bambu_slice",
  {
    title: "Fatiar modelo com o Bambu Studio (CLI)",
    description:
      "Fatia um arquivo 3MF de projeto usando a linha de comando do Bambu Studio e exporta um .gcode.3mf " +
      "pronto para impressão. Funciona melhor com projetos .3mf salvos pelo Bambu Studio (que já contêm " +
      "perfis de impressora/filamento/processo). Para STL puro, abra antes no Bambu Studio, configure e salve como .3mf. " +
      "O resultado pode ser enviado à impressora com bambu_upload_file + bambu_start_print.",
    inputSchema: {
      input_path: z.string().describe("Caminho do arquivo .3mf (projeto) ou .stl a fatiar"),
      output_path: z
        .string()
        .optional()
        .describe("Caminho do .gcode.3mf de saída (padrão: mesmo nome com sufixo .gcode.3mf)"),
      plate: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Placa a fatiar: 0 = todas (padrão), 1..N = placa específica"),
      extra_args: z
        .array(z.string())
        .optional()
        .describe("Argumentos extras de CLI do Bambu Studio (ex.: --load-settings, --load-filaments)"),
    },
  },
  async (args) => {
    try {
      const exe = findBambuStudio();
      if (!exe) {
        throw new Error(
          "Bambu Studio não encontrado. Instale-o ou defina BAMBU_STUDIO_PATH com o caminho do executável."
        );
      }
      if (!existsSync(args.input_path)) {
        throw new Error(`Arquivo de entrada não encontrado: ${args.input_path}`);
      }
      const input = path.resolve(args.input_path);
      const output =
        args.output_path ||
        path.join(
          path.dirname(input),
          path.basename(input).replace(/\.(3mf|stl)$/i, "") + ".gcode.3mf"
        );

      const cliArgs = [
        "--slice",
        String(args.plate ?? 0),
        "--export-3mf",
        output,
        ...(args.extra_args || []),
        input,
      ];

      const result = await new Promise((resolve) => {
        execFile(exe, cliArgs, { timeout: 300_000, windowsHide: true }, (error, stdout, stderr) => {
          resolve({ error, stdout: stdout?.toString() || "", stderr: stderr?.toString() || "" });
        });
      });

      const produced = existsSync(output);
      if (!produced) {
        throw new Error(
          `O fatiamento não gerou o arquivo de saída.\nComando: "${exe}" ${cliArgs.join(" ")}\n` +
            `stdout: ${result.stdout.slice(-2000)}\nstderr: ${result.stderr.slice(-2000)}`
        );
      }
      const stat = await fs.stat(output);
      return text(
        `Fatiado com sucesso: ${output} (${(stat.size / 1024 / 1024).toFixed(2)} MB).\n` +
          `Próximo passo: bambu_upload_file para enviar ao SD e bambu_start_print para imprimir.`
      );
    } catch (e) {
      return errText(e);
    }
  }
);

// --- Bambu Studio: abrir arquivo no app -------------------------------------

server.registerTool(
  "bambu_open_in_studio",
  {
    title: "Abrir arquivo no Bambu Studio",
    description:
      "Abre um arquivo (.3mf, .stl, .step, .obj...) no aplicativo Bambu Studio nesta máquina, " +
      "ou apenas abre o app se nenhum arquivo for informado.",
    inputSchema: {
      file_path: z.string().optional().describe("Arquivo a abrir (opcional)"),
    },
  },
  async (args) => {
    try {
      const exe = findBambuStudio();
      if (!exe) {
        throw new Error(
          "Bambu Studio não encontrado. Instale-o ou defina BAMBU_STUDIO_PATH com o caminho do executável."
        );
      }
      const spawnArgs = [];
      if (args.file_path) {
        if (!existsSync(args.file_path)) {
          throw new Error(`Arquivo não encontrado: ${args.file_path}`);
        }
        spawnArgs.push(path.resolve(args.file_path));
      }
      const child = spawn(exe, spawnArgs, { detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
      return text(
        args.file_path
          ? `Bambu Studio aberto com: ${args.file_path}`
          : "Bambu Studio aberto."
      );
    } catch (e) {
      return errText(e);
    }
  }
);

// --- Diagnóstico ------------------------------------------------------------

server.registerTool(
  "bambu_check_setup",
  {
    title: "Verificar configuração da integração",
    description:
      "Diagnóstico: verifica se o Bambu Studio foi encontrado nesta máquina e se as variáveis de " +
      "ambiente da impressora estão definidas, e testa a conexão MQTT se estiverem. " +
      "Use esta ferramenta primeiro em um desktop novo.",
    inputSchema: {},
  },
  async () => {
    const lines = [];
    const exe = findBambuStudio();
    lines.push(
      exe
        ? `✅ Bambu Studio encontrado: ${exe}`
        : "❌ Bambu Studio não encontrado (defina BAMBU_STUDIO_PATH ou instale o app). As ferramentas de impressora ainda funcionam sem ele."
    );
    lines.push(`- BAMBU_PRINTER_IP: ${process.env.BAMBU_PRINTER_IP || "(não definida)"}`);
    lines.push(`- BAMBU_ACCESS_CODE: ${process.env.BAMBU_ACCESS_CODE ? "definida" : "(não definida)"}`);
    lines.push(`- BAMBU_SERIAL: ${process.env.BAMBU_SERIAL || "(não definida)"}`);

    try {
      const cfg = printerConfig();
      const client = await mqttConnect(cfg);
      client.end(true);
      lines.push(`✅ Conexão MQTT com a impressora ${cfg.ip} OK (LAN mode ativo).`);
    } catch (e) {
      lines.push(`⚠️ Impressora: ${e.message}`);
    }
    return text(lines.join("\n"));
  }
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("bambu-studio-mcp rodando via stdio");
