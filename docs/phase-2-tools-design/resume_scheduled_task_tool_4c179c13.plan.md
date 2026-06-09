---
name: resume scheduled task tool
overview: "Añadir `resume_scheduled_task` como complemento simétrico de `cancel_scheduled_task`: reactiva tareas con `status=paused`, recalcula `next_run_at` y las deja listas para el cron runner."
todos:
  - id: db-util
    content: Añadir resumeScheduledTask en scheduled-tasks.ts + util computeNextRunAtForTask compartido
    status: completed
  - id: tool-wire
    content: Registrar resume_scheduled_task en catalog.ts, schemas.ts y TOOL_HANDLERS con resolución paused-only
    status: completed
  - id: refactor-hitl
    content: Refactorizar resolveScheduledTaskTarget compartido; HITL en graph.ts; TOOL_IDS en wizard
    status: completed
  - id: docs
    content: Actualizar clase-6_runbook y mensaje de pause en cancel_scheduled_task
    status: completed
isProject: false
---

# Plan: tool `resume_scheduled_task`

## Contexto

Ya existen tres tools de tareas programadas:

| Tool | Acción |
|------|--------|
| [`schedule_task`](packages/agent/src/tools/adapters.ts) | Crear tarea (`status=active`) |
| [`list_scheduled_tasks`](packages/agent/src/tools/adapters.ts) | Listar tareas |
| [`cancel_scheduled_task`](packages/agent/src/tools/adapters.ts) | Pausar (`paused`) o eliminar |

Falta la operación inversa: **reactivar** una tarea pausada. La BD ya soporta `status='paused'` y el cron solo ejecuta `active` ([`claimDueTasks`](packages/db/src/queries/scheduled-tasks.ts)).

```mermaid
flowchart LR
  schedule[schedule_task] --> active[status active]
  cancel[cancel_scheduled_task pause] --> paused[status paused]
  resume[resume_scheduled_task] --> active
  cron[/api/cron/scheduled-tasks] -->|"next_run_at due"| active
```

No se requiere migración SQL.

## Diseño del tool

### Identidad

- **id / name:** `resume_scheduled_task`
- **risk:** `medium` (mutación de programación → HITL en chat/Telegram; bypass en cron)
- **Parámetros:** mismos identificadores que cancel, sin `action`

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `task_id` | uuid | Condicional | ID de la tarea (preferido) |
| `prompt_match` | string | Condicional | Subcadena del prompt si no hay id |

Regla Zod: al menos uno de `task_id` o `prompt_match` (mismo `superRefine` que cancel).

### Resolución del target

Reutilizar el patrón de [`resolveCancelScheduledTaskTarget`](packages/agent/src/tools/adapters.ts) con filtro **solo `status=paused`**:

1. `task_id` → `getScheduledTaskForUser`; si no existe → `NOT_FOUND`
2. Si existe pero `status !== 'paused'` → errores explícitos:
   - `active` → `ALREADY_ACTIVE`
   - `completed` → `CANNOT_RESUME` (one-time ya ejecutada)
   - `failed` → `CANNOT_RESUME`
3. `prompt_match` → buscar solo en tareas pausadas; 0 → `NOT_FOUND`; >1 → `AMBIGUOUS` con `candidates`

**Refactor recomendado:** extraer helper genérico `resolveScheduledTaskTarget({ userId, task_id?, prompt_match?, allowedStatuses })` en `adapters.ts` y usarlo desde cancel y resume para evitar duplicación.

### Recalcular `next_run_at` al reactivar

Lógica crítica — al pausar, `next_run_at` no se borra pero el cron ignora la fila. Al reactivar hay que asegurar un `next_run_at` válido **desde ahora**:

| `schedule_type` | Regla |
|-----------------|-------|
| **recurring** | `Cron(cron_expr, { timezone }).nextRun()` — misma lógica que [`schedule_task`](packages/agent/src/tools/adapters.ts) y [`computeNextRunAt`](apps/web/src/app/api/cron/scheduled-tasks/route.ts) |
| **one_time** | Si `run_at` > now → `next_run_at = run_at`. Si `run_at` <= now → `{ ok: false, code: "RUN_AT_PAST", message: "..." }` sugiriendo crear nueva tarea con `schedule_task` |

**Extracción DRY (opcional pero recomendada):** mover `computeNextRunAtForTask(task)` a un módulo compartido, p. ej. `packages/agent/src/tools/scheduledTaskUtils.ts`, usado por cron route y resume handler.

### Salida JSON

**Éxito:**
```json
{
  "ok": true,
  "task_id": "uuid",
  "status": "active",
  "next_run_at": "2026-06-09T14:00:00.000Z",
  "message": "Tarea reactivada. Próxima ejecución: ..."
}
```

**Errores:** `NOT_FOUND`, `AMBIGUOUS`, `ALREADY_ACTIVE`, `CANNOT_RESUME`, `RUN_AT_PAST`, `INVALID_INPUT` — patrón `{ ok: false, error: { code, message }, candidates? }`.

### HITL

Mensaje en [`buildConfirmationMessage`](packages/agent/src/graph.ts):
> "Se requiere confirmación para reactivar la tarea `{task_id}` / cuyo prompt contiene \"...\""

Actualizar el mensaje de pause en cancel (hoy dice "reactivar manualmente en la base de datos") para mencionar `resume_scheduled_task`.

## Cambios por archivo

### DB — [`packages/db/src/queries/scheduled-tasks.ts`](packages/db/src/queries/scheduled-tasks.ts)

Nueva función:

```ts
resumeScheduledTask(db, taskId, userId, nextRunAt: string)
  → UPDATE status='active', next_run_at=nextRunAt, updated_at=now
  → .eq('user_id', userId).eq('status', 'paused')  // guard extra
  → return ScheduledTask | null
```

El guard `status='paused'` evita race conditions si otra operación cambió el estado.

### Catálogo — [`packages/types/src/catalog.ts`](packages/types/src/catalog.ts)

Entrada después de `cancel_scheduled_task`:

- `description` (inglés): cuándo usar (después de pause), parámetros, reglas one_time/recurring, códigos de error
- `displayName`: "Reactivar tarea programada"
- `displayDescription`: "Reactiva una tarea pausada y recalcula la próxima ejecución (requiere confirmación)."

Actualizar descripción de `list_scheduled_tasks` para mencionar también resume.

### Zod — [`packages/agent/src/tools/schemas.ts`](packages/agent/src/tools/schemas.ts)

```ts
resume_scheduled_task: z.object({
  task_id: z.string().uuid().optional(),
  prompt_match: z.string().min(1).optional(),
}).superRefine(/* task_id o prompt_match */)
```

### Handler — [`packages/agent/src/tools/adapters.ts`](packages/agent/src/tools/adapters.ts)

- Registrar `resume_scheduled_task` en `TOOL_HANDLERS`
- Resolver target (paused only) → validar estado → calcular `nextRunAt` → `resumeScheduledTask`
- Mensaje legible con fecha localizada (reutilizar formato de `schedule_task`)

### Util compartido (recomendado)

Nuevo [`packages/agent/src/tools/scheduledTaskUtils.ts`](packages/agent/src/tools/scheduledTaskUtils.ts):

- `computeNextRunAtForTask(task: ScheduledTask): { ok: true, nextRunAt } | { ok: false, code, message }`
- Importar en adapters y en [`apps/web/src/app/api/cron/scheduled-tasks/route.ts`](apps/web/src/app/api/cron/scheduled-tasks/route.ts) para unificar cron post-run y resume

### HITL — [`packages/agent/src/graph.ts`](packages/agent/src/graph.ts)

`case "resume_scheduled_task"` en `buildConfirmationMessage`.

### Onboarding — [`apps/web/src/app/onboarding/wizard.tsx`](apps/web/src/app/onboarding/wizard.tsx)

Añadir `"resume_scheduled_task"` a `TOOL_IDS`.

### Documentación — [`docs/phase-2-tools-design/clase-6_runbook-scheduled-tasks.md`](docs/phase-2-tools-design/clase-6_runbook-scheduled-tasks.md)

Ampliar tabla de tools y sección "Gestionar tareas desde el chat":

- Ejemplo: *"Reactiva la tarea pausada de revisar issues"*
- Nota: one-time con fecha pasada no se puede reactivar; crear nueva con `schedule_task`
- Checklist: pausar → verificar cron no ejecuta → reactivar → verificar `status=active` y nuevo `next_run_at`

## Flujo de uso

1. Usuario: *"Pausa la tarea de los issues"* → `cancel_scheduled_task` (pause)
2. Usuario: *"¿Qué tareas tengo pausadas?"* → `list_scheduled_tasks` con `status: "paused"`
3. Usuario: *"Reactiva la tarea de issues"* → `resume_scheduled_task` → confirmación → `status=active`
4. Cron la ejecuta cuando `next_run_at <= now`

## Pruebas manuales

- Reactivar recurring pausada → `next_run_at` futuro, cron la ejecuta
- Reactivar one_time pausada con `run_at` futuro → OK
- Reactivar one_time con `run_at` pasado → `RUN_AT_PAST`
- Intentar reactivar tarea ya `active` → `ALREADY_ACTIVE`
- `prompt_match` ambiguo → `AMBIGUOUS`
- HITL en chat; bypass en cron (edge case)

## Fuera de alcance (v1)

- Reactivar tareas `failed` o `completed`
- Parámetro opcional `run_at` para reprogramar one-time al reactivar (posible v2)
- UI en Settings para gestionar tareas
