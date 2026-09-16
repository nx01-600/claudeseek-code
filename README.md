# claudeseek

**Correr Claude Code completo sobre DeepSeek**, contra la API directa, sin
OpenRouter ni intermediarios. Herramientas, skills, hooks, MCP, CLAUDE.md,
subagentes e imágenes. Lo único que cambia es el modelo que responde.

Claude Code sigue siendo Claude Code: se le dice que hable con un gateway local
que traduce el protocolo de Anthropic al de DeepSeek, y nada más.

> No está afiliado a Anthropic ni a DeepSeek. Es un puente entre dos APIs
> públicas.

---

## Índice

- [Qué es](#qué-es) — especificación técnica
- [Para qué sirve](#para-qué-sirve)
- [Cómo funciona](#cómo-funciona)
- [Replicarlo en tu Claude Code](#replicarlo-en-tu-claude-code)
- [Uso](#uso)
- [Modelos](#modelos)
- [Imágenes](#imágenes)
- [Seguridad](#seguridad)
- [Limitaciones](#limitaciones)
- [Agregar un modelo](#agregar-un-modelo)
- [Solución de problemas](#solución-de-problemas)
- [Estructura del repo](#estructura-del-repo)
- [Estado](#estado)
- [Desinstalar](#desinstalar)
- [Licencia](#licencia)

---

## Qué es

Un **gateway HTTP local** que implementa la API de Mensajes de Anthropic y la
traduce a la API OpenAI-compatible de DeepSeek, en las dos direcciones. Se
interpone entre un proceso de Claude Code y `api.deepseek.com`.

### Especificación

| | |
|---|---|
| **Escucha en** | `127.0.0.1:4319` (configurable en `config.json`), solo loopback |
| **Habla** | Anthropic Messages API ↔ DeepSeek (`/chat/completions`) |
| **Upstream** | `https://api.deepseek.com` (configurable) |
| **Runtime** | Node.js 18+, sin dependencias externas (usa `fetch` nativo) |
| **Rutas que implementa** | `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`, `GET /v1/models/:id`, `GET /health` |
| **Cualquier otra ruta** | passthrough intacto a `api.anthropic.com` |
| **Configuración** | `gateway/config.json` (se lee una vez al arrancar) |
| **Secretos** | `~/.claude/deepseek-gateway/.env` (nunca se commitea) |

### Qué traduce

| Capacidad | Estado |
|---|---|
| Texto, streaming SSE y no-streaming | Sí |
| Herramientas (`tool_use` / `tool_result`) | Sí |
| **Imágenes** (mensaje del usuario y `tool_result`) | Sí, con modelos que las soporten |
| Razonamiento de DeepSeek → bloques `thinking` de Anthropic | Sí |
| `stop_reason`, `usage` (incluido cache hit) | Sí |
| System prompt | Sí |
| Herramientas de servidor de Anthropic (`web_search`, `code_execution`) | **No** — las ejecuta Anthropic, no el cliente |
| `cache_control` | **No** — DeepSeek cachea solo del lado del servidor |

### Modos de ruteo

El gateway decide por petición, con una de tres reglas:

1. **scoped** — la petición trae el token local (`config.scopedToken`), o sea
   viene de un proceso de Claude Code lanzado para correr sobre DeepSeek. Va
   **todo** a DeepSeek, incluidas las llamadas internas que Claude Code hace
   con nombres de modelo de Anthropic (opus/sonnet/haiku).
2. **modelo DeepSeek** — el nombre del modelo es de DeepSeek. Se traduce.
3. **cualquier otra cosa** — passthrough intacto a `api.anthropic.com`.

---

## Para qué sirve

Dos formas de uso, y las dos conviven con tu Claude Code normal:

1. **Delegar una tarea** desde cualquier sesión de Claude Code a otro proceso
   de Claude Code que corre sobre DeepSeek. Por defecto queda como **sesión
   visible en segundo plano** (agent view, `claude agents`,
   `claude attach/logs/stop`), así que se puede mirar y entrar como cualquier
   otra sesión en background. Con `--foreground` en cambio bloquea, devuelve un
   resumen corto y no deja sesión visible.
2. **Abrir una sesión interactiva** de Claude Code sobre DeepSeek, en primer
   plano, en su propia terminal.

La razón de delegar: tareas de mucho texto de salida (secciones de un sitio,
copy, FAQs, traducciones, boilerplate, datos de ejemplo) donde no hace falta el
criterio del modelo caro. DeepSeek sale bastante más barato.

**Tu sesión normal de Claude Code, su login por suscripción y tu
`settings.json` no se tocan nunca.**

---

## Cómo funciona

```
Sesión normal de Claude Code (login de suscripción, intacta)
  |
  | node deepseek-agent.mjs --task-file ... --dir ...
  v
claude --bg   (sesión hija, Claude Code completo, visible en agent view)
  entorno acotado vía --settings: ANTHROPIC_BASE_URL=http://127.0.0.1:4319
                                  ANTHROPIC_AUTH_TOKEN=<token local>
                                  opus/sonnet/haiku -> modelos de DeepSeek
  v
gateway local (127.0.0.1, nunca expuesto a la red)
  |-- token "scoped"        -> TODO a DeepSeek (también llamadas internas)
  |-- modelo deepseek-*     -> DeepSeek
  |-- cualquier otra cosa   -> passthrough intacto a api.anthropic.com
  v
api.deepseek.com   (la key de DeepSeek la pone el gateway)
```

### Por qué un proceso hijo y no una variable global

Claude Code acepta apuntar a un gateway propio con `ANTHROPIC_BASE_URL`, pero
en el proceso donde esa variable está puesta el login de claude.ai deja de
usarse y pasa a exigir una credencial explícita
([doc oficial](https://code.claude.com/docs/en/llm-gateway-connect)). Si esa
variable estuviera en `settings.json`, tu uso normal de Opus/Sonnet dejaría de
salir del plan pagado.

Por eso las variables se ponen **solo en el entorno de un proceso hijo**
(`gateway/scoped-env.mjs`). La sesión normal nunca las ve, y por eso podés
tener las dos cosas al mismo tiempo sin conflicto.

### El token "scoped"

`config.json` tiene un `scopedToken` con un valor fijo y público
(`deepseek-gateway-scoped`). **No es un secreto**: es una marca local que le
dice al gateway "esta petición viene de un proceso que debe ir a DeepSeek".
Sirve para que el gateway sepa enrutar incluso las llamadas internas de Claude
Code, que usan nombres de modelo de Anthropic.

La key de DeepSeek es otra cosa y nunca sale del gateway.

---

## Replicarlo en tu Claude Code

### Requisitos

- **Node.js 18 o superior** (usa `fetch` nativo).
- **Claude Code** instalado y en el PATH.
- Una **API key de DeepSeek** ([platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)).
- Windows, macOS o Linux.

### Camino rápido

```bash
git clone https://github.com/nx01-600/claudeseek-code.git
cd claudeseek-code
```

**Windows (PowerShell):**

```powershell
.\install.ps1
```

**macOS / Linux (bash):**

```bash
./install.sh
```

Cualquiera de los dos copia el gateway a `~/.claude/deepseek-gateway/` y la
skill a `~/.claude/skills/claudeseek/`. Es seguro correrlo varias veces: nunca
pisa `.env` ni los logs.

Después, pegá la API key en `~/.claude/deepseek-gateway/.env`:

```
DEEPSEEK_API_KEY=sk-tu-key-aca
```

Y verificá:

```bash
node "$HOME/.claude/deepseek-gateway/cli.mjs" doctor
```

El `doctor` chequea la key, si el gateway responde, la conectividad con
DeepSeek y qué modelos hay vivos, incluyendo si cada uno analiza imágenes.

No hace falta reiniciar Claude Code. El gateway arranca solo la primera vez que
algo lo usa.

### Replicarlo a mano (entender cada pieza)

Si querés hacerlo paso a paso sin el instalador:

**1. Copiar el gateway**

```bash
mkdir -p ~/.claude/deepseek-gateway
cp gateway/*.mjs gateway/*.json gateway/dsk gateway/dsk.cmd \
   gateway/deepseek-session gateway/deepseek-session.cmd \
   ~/.claude/deepseek-gateway/
```

**2. Poner la API key**

```bash
echo 'DEEPSEEK_API_KEY=sk-tu-key-aca' > ~/.claude/deepseek-gateway/.env
```

**3. Copiar la skill**

```bash
mkdir -p ~/.claude/skills
cp -r claudeseek ~/.claude/skills/claudeseek
```

La skill es la que le enseña a Claude Code *cuándo* delegar. Sin ella igual
funciona todo, pero Claude Code no va a proponer delegar solo.

**4. Arrancar el gateway y comprobar que responde**

```bash
node ~/.claude/deepseek-gateway/cli.mjs gateway start
node ~/.claude/deepseek-gateway/cli.mjs doctor
```

**5. Probar una sesión sobre DeepSeek**

```bash
node ~/.claude/deepseek-gateway/deepseek-session.mjs --model deepseek-flash
```

Si eso abre una sesión de Claude Code y te responde, ya está: el resto
(delegación en segundo plano, comando corto `deepseek`) es azúcar sobre lo
mismo.

### Cómo comprobar que de verdad va a DeepSeek

```bash
node ~/.claude/deepseek-gateway/cli.mjs gateway logs
```

Cada línea dice a dónde fue la petición:

```
POST /v1/messages model=deepseek-flash -> deepseek(scoped)
POST /v1/messages model=claude-sonnet-5 -> passthrough
```

Y el costo real, que Claude Code no puede calcular:

```bash
node ~/.claude/deepseek-gateway/cli.mjs cost --since 1d
```

---

## Uso

### Delegar desde Claude Code

Normalmente lo hace Claude Code solo, siguiendo la skill `claudeseek`. A mano:

```bash
node "$HOME/.claude/deepseek-gateway/deepseek-agent.mjs" \
  --task-file brief.md \
  --dir "/ruta/al/proyecto" \
  [--model deepseek-flash-thinking] \
  [--label nombre-corto] \
  [--foreground]
```

Queda como sesión visible en segundo plano: el recibo trae el id y los comandos
para seguirla (`claude attach` / `logs` / `stop`). Varias tareas en paralelo son
una invocación por tarea, trabajando sobre archivos distintos.

Corre con `--permission-mode bypassPermissions` y lo único bloqueado por defecto
es `git push`, en ambos modos.

### Sesión interactiva

```
deepseek [--model deepseek-flash-thinking] [-c|-r] [--dangerously-skip-permissions]
```

El comando corto `deepseek` se instala en `~/.local/bin` (si esa carpeta
existe) y equivale a `~/.claude/deepseek-gateway/deepseek-session`. Dentro de la
sesión, `/model` alterna entre la variante con y sin razonamiento.

### Diagnóstico y costo

```bash
node "$HOME/.claude/deepseek-gateway/cli.mjs" doctor           # key, gateway, conectividad, modelos
node "$HOME/.claude/deepseek-gateway/cli.mjs" cost --since 7d  # costo real en DeepSeek
node "$HOME/.claude/deepseek-gateway/cli.mjs" gateway restart  # tras cambiar config.json o el código
node "$HOME/.claude/deepseek-gateway/cli.mjs" gateway logs     # últimas peticiones y a dónde se enrutaron
```

El costo en dólares que muestra Claude Code dentro de una sesión DeepSeek **no
es real** (usa tarifas de Anthropic). El real es el de `cost`, que se calcula
con `prices.json` sobre el consumo registrado en `usage.jsonl`.

---

## Modelos

Se definen en `gateway/config.json`:

| Nombre en Claude Code | Modelo DeepSeek | Razonamiento | Imágenes |
|---|---|---|---|
| `deepseek-flash` (default) | `deepseek-flash` | Solo si Claude Code lo pide | **Sí** |
| `deepseek-flash-thinking` | `deepseek-flash` | Siempre | **Sí** |
| `deepseek-pro` / `deepseek-pro-thinking` | `deepseek-v4-pro` | Igual que arriba | No |

El razonamiento de DeepSeek se expone como bloque *thinking* nativo de Claude
Code. `roleModels` define a qué modelo van los subagentes y las llamadas
internas que Claude Code hace con nombres opus/sonnet/haiku.

---

## Imágenes

El gateway traduce las imágenes al formato que DeepSeek acepta, en los dos
lugares donde Claude Code las manda:

- **en el mensaje del usuario** — capturas pegadas, fotos, diagramas;
- **dentro de un `tool_result`** — así llegan las capturas de pantalla que
  devuelve una herramienta. Esto es lo que hace viable el control de navegador
  (por ejemplo la integración *Claude in Chrome*): el modelo efectivamente ve
  la página, no un texto de aviso.

En el protocolo se traduce un bloque `image` de Anthropic
(`{type: "image", source: {type: "base64", media_type, data}}`) a una parte
`image_url` de OpenAI (`{type: "image_url", image_url: {url: "data:...;base64,..."}}`).
DeepSeek acepta esa forma tanto en un mensaje del usuario como en uno `role:
"tool"`, que es lo que permite el segundo caso.

`deepseek-v4-pro` no analiza imágenes. Con ese modelo el gateway reemplaza cada
una por un aviso de texto, en vez de mandarle a DeepSeek algo que va a
rechazar. Si la tarea depende de ver imágenes, hay que usar `deepseek-flash`
(las variantes con y sin razonamiento sirven igual).

Un detalle medido: una imagen hace razonar más al modelo, así que con
`max_tokens` chico el presupuesto se agota en el razonamiento y la respuesta de
texto puede salir vacía. Con los valores que usa Claude Code no pasa.

---

## Seguridad

- El gateway escucha **solo en `127.0.0.1`**, nunca se expone a la red.
- La key de DeepSeek vive en `~/.claude/deepseek-gateway/.env` y **solo la usa
  el gateway**. Nunca viaja a Anthropic ni a los procesos hijos de Claude Code.
- Al revés, las credenciales de Anthropic nunca viajan a DeepSeek.
- `.env`, `usage.jsonl`, `agent-runs.jsonl`, `gateway.log` y `.bg-settings/`
  están en `.gitignore`: no se commitean.

---

## Limitaciones

- **WebSearch** no funciona: es una herramienta que ejecuta Anthropic en sus
  servidores. WebFetch sí funciona.
- **Connectors de claude.ai** (Gmail, Canva, etc.) no cargan en procesos sobre
  DeepSeek, porque dependen del login de claude.ai. Los MCP locales sí andan.
- **Imágenes**: las analizan los modelos `deepseek-flash*`. Con `deepseek-pro*`
  llega un aviso de texto en su lugar.
- Claude Code imprime un aviso `unrecognized_model` al arrancar: es inofensivo,
  solo indica que no conoce el nombre del modelo.
- `/v1/messages/count_tokens` devuelve una estimación (caracteres / 4), no un
  conteo real.
- El bloqueo de `git push` depende de las reglas `--disallowedTools` de Claude
  Code.
- Solo se probó a fondo en Windows. El código es Node puro y los instaladores
  cubren macOS y Linux, pero esos dos caminos todavía no se verificaron.

---

## Agregar un modelo

En `gateway/config.json`:

```json
"mi-modelo": { "id": "nombre-real-en-deepseek", "thinking": "auto", "vision": true }
```

- `thinking`: `"on"` (siempre razona), `"off"` (nunca) o `"auto"` (solo si
  Claude Code lo pide).
- `vision`: `true` si el modelo analiza imágenes. Si lo dejás afuera se asume
  `true`, para que una imagen no se descarte en silencio; el costo es que un
  modelo sin visión devuelve un error visible de DeepSeek.

Después de tocar `config.json` hay que reiniciar el gateway
(`cli.mjs gateway restart`), porque se lee una sola vez al arrancar.

---

## Solución de problemas

| Síntoma | Qué hacer |
|---|---|
| `Sin API key de DeepSeek` | Pegar la key en `~/.claude/deepseek-gateway/.env` |
| `El gateway DeepSeek no arrancó` | Correr `doctor` y `gateway logs` |
| `unrecognized_model` al arrancar | Inofensivo, se puede ignorar |
| Las imágenes no llegan | Estás en `deepseek-pro*`; cambiá a `deepseek-flash` |
| Respuestas de texto vacías | `max_tokens` chico y el razonamiento se comió el presupuesto |
| Cambié `config.json` y no pasa nada | Falta `cli.mjs gateway restart` |
| El costo que muestra Claude Code no cierra | Es el de Anthropic; el real es `cli.mjs cost` |

---

## Estructura del repo

```
gateway/
  server.mjs             Gateway: ruteo scoped/passthrough, streaming, errores
  translate.mjs          Anthropic Messages API <-> formato OpenAI de DeepSeek
  deepseek-client.mjs    Cliente DeepSeek, key, catálogo de modelos, precios
  scoped-env.mjs         Entorno acotado para procesos de Claude Code
  start.mjs              Arranque idempotente del gateway
  cli.mjs (dsk)          doctor / models / cost / key / gateway start|stop|restart|logs
  deepseek-agent.mjs     Delegación headless
  deepseek-session.mjs   Sesión interactiva (+ .cmd y shim bash)
  bin/                   Shims del comando corto `deepseek`
  config.json / prices.json
claudeseek/SKILL.md      Cuándo y cómo delegar (lo que lee Claude Code)
install.sh / install.ps1
uninstall.sh / uninstall.ps1
```

---

## Estado

Verificado el 2026-09-15 contra DeepSeek real a través del gateway: texto en
streaming con tildes, razonamiento visible con firma, llamada interna con
nombre de haiku enrutada a DeepSeek, ciclo de herramientas de dos turnos en
modo razonamiento, passthrough real a Anthropic, `/v1/models` y
`count_tokens`. Además, una delegación completa (el agente creó y leyó un
archivo), el lanzador de sesión en modo `-p`, y la traducción de imágenes en
sus cuatro casos: texto+imagen, solo imagen, imagen dentro de un `tool_result`
y modelo sin visión.

---

## Desinstalar

```bash
./uninstall.sh        # macOS / Linux
.\uninstall.ps1       # Windows
```

Mata el gateway si está corriendo, borra el código y la skill, y **conserva
`.env`, `usage.jsonl` y `agent-runs.jsonl`** por si querés reinstalar sin perder
el historial de costos.

---

## Licencia

[Apache-2.0](LICENSE).
