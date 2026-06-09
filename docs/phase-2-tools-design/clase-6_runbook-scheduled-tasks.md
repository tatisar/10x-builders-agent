# Tareas programadas (Scheduled Tasks)

## Arquitectura

```
Usuario (chat)
    │  "Recuérdame revisar mis issues el lunes a las 9 AM"
    ▼
Agente  ──[schedule_task tool]──► scheduled_tasks (DB)
                                        │
                              (next_run_at <= now)
                                        │
Supabase Cron ──► POST /api/cron/scheduled-tasks
                        │
                        ├──► runAgent(prompt del usuario)
                        ├──► scheduled_task_runs (audit)
                        └──► Telegram sendMessage (por defecto)
```

## Tablas nuevas

### `scheduled_tasks`
| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | uuid | PK |
| `user_id` | uuid | FK → profiles |
| `prompt` | text | Instrucción que se enviará al agente |
| `schedule_type` | text | `one_time` o `recurring` |
| `run_at` | timestamptz | Para one_time: cuándo ejecutar |
| `cron_expr` | text | Para recurring: expresión cron de 5 campos |
| `timezone` | text | IANA timezone (ej. `America/Bogota`) |
| `status` | text | `active`, `paused`, `completed`, `failed` |
| `last_run_at` | timestamptz | Última ejecución |
| `next_run_at` | timestamptz | Próxima ejecución (índice para el runner) |

### `scheduled_task_runs`
| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | uuid | PK |
| `task_id` | uuid | FK → scheduled_tasks |
| `status` | text | `running`, `completed`, `failed` |
| `started_at` | timestamptz | Inicio de ejecución |
| `finished_at` | timestamptz | Fin de ejecución |
| `error` | text | Mensaje de error si falló |
| `agent_session_id` | uuid | Sesión del agente usada (canal `cron`) |
| `notified` | boolean | Si se envió notificación Telegram |
| `notification_error` | text | Razón si no se notificó |

## Setup

### 1. Aplicar la migración SQL

En el panel de Supabase → SQL Editor, ejecuta el contenido de:

```
packages/db/supabase/migrations/00003_scheduled_tasks.sql
```

O con la CLI de Supabase:
```bash
supabase db push
```

### 2. Variables de entorno

Agrega a tu `.env.local`:
```
CRON_SECRET=un-token-secreto-largo-y-aleatorio
```

### 3. Configurar Supabase Cron

En el panel de Supabase → **Database → Extensions**, activa `pg_cron`.

Luego en **Database → Cron Jobs**, crea un nuevo job:

```sql
SELECT cron.schedule(
  'run-scheduled-tasks',          -- nombre del job
  '* * * * *',                    -- cada minuto
  $$
    SELECT net.http_post(
      url := 'https://TU_DOMINIO/api/cron/scheduled-tasks',
      headers := '{"Authorization": "Bearer TU_CRON_SECRET", "Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    );
  $$
);
```

> Reemplaza `TU_DOMINIO` con tu dominio de producción y `TU_CRON_SECRET` con el valor de `CRON_SECRET`.

**Alternativa con Supabase Edge Functions:**
Crea una Edge Function que haga el `fetch` al endpoint cada minuto usando `Deno.cron`.

### 4. Habilitar el tool para el usuario

El tool `schedule_task` tiene riesgo `medium`, por lo que requiere que el usuario lo habilite en Ajustes → Herramientas.

## Uso desde el chat

### Tarea de una sola vez
```
Recuérdame el viernes 11 de abril a las 9 AM revisar el estado de los issues de GitHub del repo lab10/agents
```
El agente llamará a `schedule_task` con:
- `schedule_type: "one_time"`
- `run_at: "2026-04-11T09:00:00-05:00"`
- `prompt: "Revisa el estado de los issues de GitHub del repo lab10/agents"`

### Tarea recurrente
```
Todos los lunes a las 8 AM quiero que me des un resumen de los issues abiertos de mi repo principal
```
El agente llamará a `schedule_task` con:
- `schedule_type: "recurring"`
- `cron_expr: "0 8 * * 1"`
- `timezone: "America/Bogota"` (si está configurado en el perfil)

### Referencia de expresiones cron
| Expresión | Significado |
|-----------|-------------|
| `0 9 * * 1` | Cada lunes a las 9 AM |
| `0 8 * * 1-5` | Lunes a viernes a las 8 AM |
| `0 */6 * * *` | Cada 6 horas |
| `0 9 1 * *` | El 1ro de cada mes a las 9 AM |
| `*/15 * * * *` | Cada 15 minutos |

## Gestionar tareas desde el chat

Además de `schedule_task`, el agente dispone de:

| Tool | Riesgo | Confirmación |
|------|--------|--------------|
| `list_scheduled_tasks` | bajo | No |
| `cancel_scheduled_task` | medio | Sí (HITL) |
| `resume_scheduled_task` | medio | Sí (HITL) |

Habilítalos en **Ajustes → Herramientas** junto con `schedule_task`.

### Listar tareas

Ejemplos de prompts:

- "¿Qué tareas programadas tengo?"
- "Muéstrame mis tareas activas"

El agente llamará a `list_scheduled_tasks` (opcionalmente con `status: "active"`). La respuesta incluye `task_id` para cada tarea.

### Pausar o eliminar una tarea

Ejemplos:

- "Pausa la tarea que me recuerda revisar issues"
- "Elimina la tarea con id `uuid-aqui`"

El agente llamará a `cancel_scheduled_task` con:

- `action: "pause"` — deja `status=paused`; el cron ya no la ejecuta
- `action: "delete"` — borra la fila (y sus runs en cascada)

Identificación de la tarea:

- Por `task_id` (preferido, devuelto por `list_scheduled_tasks` o al crear la tarea)
- Por `prompt_match` (subcadena del prompt; si hay varias coincidencias, el tool devuelve `AMBIGUOUS` con candidatos)

Las tareas `completed` no se pueden cancelar.

### Reactivar una tarea pausada

Ejemplos:

- "Reactiva la tarea pausada de revisar issues"
- "Reanuda la tarea con id `uuid-aqui`"

El agente llamará a `resume_scheduled_task` con `task_id` o `prompt_match`. Solo funciona con tareas `status=paused`. Al reactivar:

- **Recurrente:** recalcula `next_run_at` con la próxima ocurrencia del cron desde ahora
- **One-time:** reutiliza `run_at` solo si sigue en el futuro; si ya pasó, devuelve `RUN_AT_PAST` (crear nueva tarea con `schedule_task`)

Identificación: igual que cancel (`task_id` preferido, `prompt_match` como alternativa).

## Notificaciones Telegram

Por defecto, cada ejecución envía el resultado al chat de Telegram vinculado.  
Si el usuario **no tiene Telegram vinculado**, la ejecución continúa normalmente y se registra `notified=false` con motivo `no_telegram_link` en `scheduled_task_runs`. No se lanza error.

## Pruebas manuales

### Verificar que el tool funciona
1. Habilita `schedule_task` en Ajustes → Herramientas.
2. En el chat escribe: "Programa una tarea para dentro de 2 minutos que me diga hola".
3. Confirma la acción cuando el agente la solicite.
4. Revisa la tabla `scheduled_tasks` en Supabase.

### Disparar el cron manualmente
```bash
curl -X POST https://TU_DOMINIO/api/cron/scheduled-tasks \
  -H "Authorization: Bearer TU_CRON_SECRET" \
  -H "Content-Type: application/json"
```

Respuesta esperada:
```json
{
  "processed": 1,
  "results": [{ "task_id": "...", "status": "ok" }]
}
```

### Verificar ejecución
Revisa en Supabase:
- `scheduled_task_runs`: debe haber un registro con `status=completed`
- `agent_sessions`: debe existir una sesión con `channel=cron`
- `agent_messages`: debe tener los mensajes de esa sesión
- Si tienes Telegram vinculado, debes recibir el mensaje

### Verificar listado y cancelación
1. Habilita `list_scheduled_tasks` y `cancel_scheduled_task` en Ajustes → Herramientas.
2. Crea una tarea de prueba con `schedule_task`.
3. Pide "muéstrame mis tareas programadas" — debe listar la tarea con `task_id`.
4. Pide "pausa la tarea de …" (usando un fragmento del prompt) — confirma en UI.
5. Verifica en `scheduled_tasks` que `status=paused`.
6. Dispara el cron manualmente — la tarea pausada **no** debe ejecutarse.
7. Pide "elimina la tarea con id …" — confirma — la fila debe desaparecer de `scheduled_tasks`.
8. Caso ambiguo: crea dos tareas con prompts similares y cancela por `prompt_match` — debe devolver error `AMBIGUOUS` con candidatos.

### Verificar reactivación
1. Habilita `resume_scheduled_task` en Ajustes → Herramientas.
2. Pausa una tarea con `cancel_scheduled_task` (action pause).
3. Pide "muéstrame mis tareas pausadas" — debe aparecer con `status=paused`.
4. Pide "reactiva la tarea de …" — confirma en UI.
5. Verifica en `scheduled_tasks`: `status=active` y `next_run_at` actualizado.
6. Dispara el cron cuando `next_run_at <= now` — la tarea debe ejecutarse.
7. One-time con `run_at` pasado: al reactivar debe devolver `RUN_AT_PAST`.
