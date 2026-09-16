---
name: claudeseek
description: Usar para delegar una tarea a un Claude Code completo (todas las herramientas, skills, MCP, subagentes y razonamiento opcional) que corre sobre DeepSeek en vez del modelo actual. Típico para tareas grandes de escritura o generación de contenido (secciones de un sitio, copy, FAQs, traducciones, boilerplate, datos de ejemplo) donde no hace falta el criterio del modelo caro. También cuando el usuario diga "delegá a deepseek", "usá deepseek", "mandalo a deepseek", "/deepseek" o pregunte cómo abrir una sesión sobre DeepSeek. Además aplica DENTRO de una sesión que ya corre sobre DeepSeek cuando necesita WebSearch o cualquier otra herramienta de servidor de Anthropic que no existe ahí: esta skill explica cómo escalar ese paso puntual a un Sonnet real.
---

# Delegar a DeepSeek desde Claude Code

DeepSeek funciona acá como **otro modelo de Claude Code**: la delegación
levanta un `claude -p` real, con todo lo que tiene cualquier sesión
(herramientas, skills, hooks, MCP, CLAUDE.md, subagentes), pero cuyas
llamadas al modelo van a la API directa de DeepSeek a través de un gateway
local. Ese proceso es independiente de esta sesión: no toca su login ni su
configuración.

## Regla de oro

El agente delegado ya viene instruido para terminar con una respuesta corta
(archivos tocados + una frase). **No leas completos los archivos que
escribió** salvo que esa respuesta indique un problema: leerlos anula el
ahorro de tokens, que es la razón de delegar. Para verificar, alcanza con
mirar el inicio/fin del archivo o buscar algo puntual.

## Cuándo delegar

| Delegar a DeepSeek | Resolver en esta sesión |
|---|---|
| Escribir o adaptar contenido largo (copy, secciones, FAQs, fichas) | Decisiones de arquitectura o diseño |
| Tareas repetitivas bien especificadas (boilerplate, datos de ejemplo, traducciones) | Cambios que exigen entender a fondo el resto del repo |
| Lotes de archivos independientes entre sí | Tareas chicas: levantar otro proceso no se paga |

**Aviso proactivo:** si una tarea que pidió el usuario implica mucho texto de
salida (del orden de 1500 palabras o más), proponé en una línea delegarla a
DeepSeek y esperá su OK. No delegues por cuenta propia sin ese OK, salvo que
el usuario ya lo haya autorizado en esta sesión.

## Cómo delegar

1. Escribí el brief a un archivo (scratchpad de la sesión). Siempre archivo:
   evita problemas de comillas y acentos entre PowerShell y Bash. El brief
   tiene que ser autosuficiente: el agente delegado no ve esta conversación.
2. Ejecutá:

```bash
node "$HOME/.claude/deepseek-gateway/deepseek-agent.mjs" \
  --task-file "<ruta del brief>" \
  --dir "<carpeta del proyecto>" \
  --label "<nombre corto>"
```

**Por defecto queda como sesión visible en segundo plano** (no bloquea esta
llamada): aparece en el agent view de Claude Code (el usuario entra con ←
desde su sesión, o vos con `claude attach <id>`), en `claude agents`, y sigue
corriendo aunque termine este comando. El recibo trae el id y los comandos
para seguirla (`attach` / `logs` / `stop`). Si el usuario pregunta "¿cómo veo
lo que está haciendo?" o "¿cómo entro?", esa es la respuesta: tecla ← o
`claude attach <id>`.

Con `--foreground` en cambio bloquea esta llamada y devuelve un resumen corto
al terminar (no queda una sesión visible después) — útil cuando lo único que
importa es el resultado final y no hace falta inspeccionarlo.

Opciones útiles:

- `--model deepseek-flash` (default): razona solo si hace falta (si Claude
  Code lo pide).
- `--model deepseek-flash-thinking`: razona siempre. Para tareas que exigen
  pensar (lógica, planificación, código no trivial).
- `--name <texto>`: nombre de la sesión en el agent view (default: `--label`
  o el nombre de la carpeta).
- `--permission-mode <modo>`: default `bypassPermissions` (no pide
  confirmaciones). Lo único bloqueado por defecto es `git push`.
- `--timeout-min <n>`: solo aplica con `--foreground` (default 30).

**Varias tareas en paralelo:** una invocación por tarea (cada una devuelve su
propio id de inmediato, no hace falta `run_in_background` de Bash). Que
trabajen sobre archivos distintos.

## Sesión interactiva sobre DeepSeek (para el usuario)

Si el usuario quiere trabajar él mismo sobre DeepSeek:

```
$HOME/.claude/deepseek-gateway/deepseek-session.cmd
$HOME/.claude/deepseek-gateway/deepseek-session.cmd --model deepseek-flash-thinking
```

Es una sesión normal de Claude Code en esa terminal, con todo disponible.
Dentro, `/model` permite alternar entre la variante con y sin razonamiento.
No afecta ninguna otra sesión abierta.

## Escalar a Sonnet real (para una sesión que YA corre sobre DeepSeek)

Si estás corriendo sobre DeepSeek y la tarea necesita algo que acá no existe
— WebSearch es el caso típico, ver Limitaciones — no lo inventes ni lo des
por imposible: podés escalar ese paso puntual a un Claude Code real (Sonnet,
tu login por suscripción) sin salir de esta sesión, vía Bash:

```bash
node "$HOME/.claude/deepseek-gateway/escalate-to-sonnet.mjs" \
  --task "Buscá en la web: <query concreta> y devolveme los datos con fuentes" \
  --dir "<carpeta actual>"
```

Para tareas más largas, `--task-file <ruta>` en vez de `--task`. Bloquea y
devuelve la respuesta de texto de Sonnet; no queda una sesión visible
después. Usalo solo para el paso puntual que lo necesita (una búsqueda, un
dato que hay que verificar), no para delegarle la tarea entera — eso
consume cuota/costo real de Anthropic, no la de DeepSeek.

## Diagnóstico y costo

```bash
node "$HOME/.claude/deepseek-gateway/cli.mjs" doctor           # key, gateway, conectividad
node "$HOME/.claude/deepseek-gateway/cli.mjs" gateway restart  # tras cambiar config.json
node "$HOME/.claude/deepseek-gateway/cli.mjs" gateway logs     # últimas peticiones
node "$HOME/.claude/deepseek-gateway/cli.mjs" cost --since 7d  # costo real en DeepSeek
```

El costo en dólares que reporta Claude Code dentro de una sesión sobre
DeepSeek **no es real** (usa tarifas de Anthropic). El real es el de `cost`.

## Errores comunes

| Mensaje | Qué hacer |
|---|---|
| `Sin API key de DeepSeek` | Avisar al usuario: pegarla en `$HOME/.claude/deepseek-gateway/.env` |
| `El gateway DeepSeek no arrancó` | Correr `doctor` y `gateway logs` |
| `AGENTE-DEEPSEEK CON ERROR` (solo `--foreground`) | Leer el resultado: el agente explica qué falló |
| `No se pudo iniciar la sesión en segundo plano` | Se imprime el stderr/stdout del proceso; revisarlo antes de reintentar |

## Limitaciones

- Las herramientas "de servidor" de Anthropic (WebSearch) no existen en
  DeepSeek. WebFetch sí funciona. Para escalar un paso puntual a Sonnet
  real, ver "Escalar a Sonnet real" más arriba.
- Las imágenes las analiza `deepseek-flash`, incluso dentro de un
  `tool_result` (sirve para capturas de pantalla). `deepseek-pro` no las ve:
  ahí llega un aviso de texto.
- `deepseek-pro` hoy lo redirige DeepSeek a `deepseek-flash` (desde el
  14-sep-2026), así que en la práctica son el mismo modelo.
