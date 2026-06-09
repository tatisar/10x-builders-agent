---
name: Scheduled tasks tools
overview: Añadir dos tools al agente — `list_scheduled_tasks` (lectura, riesgo bajo) y `cancel_scheduled_task` (pausar o eliminar, riesgo medio con HITL) — reutilizando la tabla y queries existentes en `scheduled_tasks`.
todos:
  - id: db-queries
    content: "Extender scheduled-tasks.ts: filtro por status, getForUser, pauseScheduledTask, deleteScheduledTask"
    status: completed
  - id: catalog-schemas
    content: Añadir list_scheduled_tasks y cancel_scheduled_task a TOOL_CATALOG y TOOL_SCHEMAS (Zod + superRefine)
    status: completed
  - id: handlers
    content: "Implementar handlers en adapters.ts con resolución task_id/prompt_match y errores { ok: false }"
    status: completed
  - id: hitl-onboarding
    content: Añadir case en graph.ts buildConfirmationMessage y los 3 ids en wizard TOOL_IDS (incl. schedule_task)
    status: completed
  - id: docs-tests
    content: Actualizar clase-6_runbook con ejemplos de listado/cancelación y checklist de pruebas manuales
    status: completed
isProject: false
---

# Plan: `list_scheduled_tasks` y `cancel_scheduled_task`

## Contexto

Hoy solo existe [`schedule_task`](packages/agent/src/tools/adapters.ts) para **crear** tareas. La capa de datos ya tiene soporte parcial:

- Tabla `scheduled_tasks` con `status IN ('active','paused','completed','failed')` — [00003_scheduled_tasks.sql](packages/db/supabase/migrations/00003_scheduled_tasks.sql)
- Tipos en [`packages/types/src/index.ts`](packages/types/src/index.ts): `ScheduledTask`, `ScheduledTaskStatus`
- Query existente: `listScheduledTasksByUser` en [`packages/db/src/queries/scheduled-tasks.ts`](packages/db/src/queries/scheduled-tasks.ts)
- El cron runner solo ejecuta tareas con `status = 'active'` (`claimDueTasks`)

No se requiere migración SQL.

```mermaid
flowchart LR
  agent[Agente]
  listTool[list_scheduled_tasks]
  cancelTool[cancel_scheduled_task]
  db[(scheduled_tasks)]
  cron[/api/cron/scheduled-tasks]

  agent --> listTool --> db
  agent -->|"HITL approve"| cancelTool --> db
  cron -->|"solo status=active"| db
```

## Diseño de las dos tools

### 1. `list_scheduled_tasks` (riesgo: `low`)

**Propósito:** Permitir al agente (y al usuario) ver tareas antes de cancelar.

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `status` | enum | No | `active`, `paused`, `completed`, `failed`, o omitir = todas |

**Salida JSON estable:**
```json
{
  "ok": true,
  "tasks": [
    {
      "task_id": "uuid",
      "prompt": "...",
      "schedule_type": "one_time|recurring",
      "cron_expr": "...",
      "next_run_at": "...",
      "status": "active",
      "created_at": "..."
    }
  ],
  "count": 1
}
```

- Sin confirmación HITL (mismo patrón que `list_enabled_tools`).
- Siempre filtrado por `ctx.userId` (RLS + guard en handler).

### 2. `cancel_scheduled_task` (riesgo: `medium`)

**Propósito:** Detener ejecuciones futuras de una tarea concreta.

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `task_id` | string (uuid) | Condicional | ID devuelto por `list_scheduled_tasks` o al crear con `schedule_task` |
| `prompt_match` | string | Condicional | Subcadena para localizar la tarea si el usuario no tiene el ID |
| `action` | enum | Sí | `pause` → `status='paused'`; `delete` → `DELETE` de la fila |

**Reglas de resolución:**
1. Si viene `task_id` → buscar tarea del usuario; si no existe → `{ ok: false, error: NOT_FOUND }`.
2. Si solo viene `prompt_match` → filtrar tareas **activas o pausadas** del usuario cuyo `prompt` contenga la subcadena (case-insensitive).
   - 0 matches → `NOT_FOUND`
   - \>1 matches → `AMBIGUOUS` con lista de `task_id` candidatos para que el usuario/agente elija
3. No permitir cancelar tareas ya `completed` (error `ALREADY_COMPLETED`).

**Salida éxito:**
```json
{
  "ok": true,
  "task_id": "uuid",
  "action": "pause|delete",
  "message": "Tarea pausada. Ya no se ejecutará hasta que se reactive manualmente."
}
```

**HITL:** riesgo `medium` → confirmación en chat/Telegram; en cron (`bypassConfirmation`) se auto-aprueba igual que `schedule_task`.

**Mensaje de confirmación** (español) en [`graph.ts`](packages/agent/src/graph.ts):
> "Se requiere confirmación para {pausar|eliminar} la tarea `{task_id}`: \"{prompt preview}...\""

## Cambios por archivo

### Base de datos — [`packages/db/src/queries/scheduled-tasks.ts`](packages/db/src/queries/scheduled-tasks.ts)

Añadir funciones (sin migración):

- `listScheduledTasksByUser(db, userId, status?)` — extender la existente con filtro opcional por `status`
- `getScheduledTaskForUser(db, taskId, userId)` — wrapper que valida ownership
- `pauseScheduledTask(db, taskId, userId)` — `UPDATE status='paused'`
- `deleteScheduledTask(db, taskId, userId)` — `DELETE` (cascade borra `scheduled_task_runs`)

Todas las mutaciones incluyen `.eq('user_id', userId)` como defensa en profundidad.

### Catálogo — [`packages/types/src/catalog.ts`](packages/types/src/catalog.ts)

Dos entradas nuevas en `TOOL_CATALOG` (después de `schedule_task`):

- `list_scheduled_tasks` — `risk: "low"`, `parameters_schema` con `status` opcional
- `cancel_scheduled_task` — `risk: "medium"`, `parameters_schema` con `task_id`, `prompt_match`, `action`
- `displayName` / `displayDescription` en español, `description` en inglés para el modelo (alineado al resto)

### Zod — [`packages/agent/src/tools/schemas.ts`](packages/agent/src/tools/schemas.ts)

```ts
list_scheduled_tasks: z.object({
  status: z.enum(["active","paused","completed","failed"]).optional(),
})

cancel_scheduled_task: z.object({
  task_id: z.string().uuid().optional(),
  prompt_match: z.string().min(1).optional(),
  action: z.enum(["pause","delete"]),
}).superRefine(/* exigir task_id o prompt_match; no ambos vacíos */)
```

### Handlers — [`packages/agent/src/tools/adapters.ts`](packages/agent/src/tools/adapters.ts)

Registrar en `TOOL_HANDLERS`:

- `list_scheduled_tasks` → llama query, mapea a respuesta resumida
- `cancel_scheduled_task` → resuelve target, ejecuta pause/delete, devuelve `{ ok, ... }` sin lanzar excepciones controladas

Patrón de errores suaves (como `fileTools.ts` / `bashExec.ts`): códigos `NOT_FOUND`, `AMBIGUOUS`, `ALREADY_COMPLETED`, `INVALID_INPUT`.

### Confirmación HITL — [`packages/agent/src/graph.ts`](packages/agent/src/graph.ts)

Añadir `case "cancel_scheduled_task"` en `buildConfirmationMessage`.

### Onboarding — [`apps/web/src/app/onboarding/wizard.tsx`](apps/web/src/app/onboarding/wizard.tsx)

Añadir al array `TOOL_IDS`:
- `schedule_task` (hoy falta)
- `list_scheduled_tasks`
- `cancel_scheduled_task`

Settings ya itera todo `TOOL_CATALOG`; el wizard necesita la lista explícita para el upsert inicial.

### Documentación — [`docs/phase-2-tools-design/clase-6_runbook-scheduled-tasks.md`](docs/phase-2-tools-design/clase-6_runbook-scheduled-tasks.md)

Sección breve "Gestionar tareas desde el chat" con ejemplos:
- "Muéstrame mis tareas programadas activas"
- "Pausa la tarea que me recuerda revisar issues"
- "Elimina la tarea con id ..."

## Flujo de uso esperado

1. Usuario: *"¿Qué tareas programadas tengo?"*
2. Agente llama `list_scheduled_tasks` → muestra lista con `task_id`
3. Usuario: *"Cancela la tarea de los issues de GitHub"*
4. Agente llama `cancel_scheduled_task` con `prompt_match` + `action: "pause"`
5. UI pide confirmación → usuario aprueba → tarea queda `paused`
6. El cron deja de ejecutarla (`claimDueTasks` filtra `status='active'`)

## Pruebas manuales

- Listar con 0, 1 y varias tareas; filtro por `status`
- Cancelar por `task_id` con `pause` y `delete`
- Cancelar por `prompt_match` con match único y ambiguo (\>1)
- Confirmar que tarea `paused` no se ejecuta al llamar `POST /api/cron/scheduled-tasks`
- Verificar HITL en chat y bypass automático si se invoca desde cron (edge case)

## Fuera de alcance (v1)

- Reactivar tarea pausada (`resume_scheduled_task`) — se puede añadir después
- UI dedicada en Settings para gestionar tareas
- Desactivar el job global de Supabase Cron (`cron.unschedule`) — sigue siendo operación manual en Supabase
