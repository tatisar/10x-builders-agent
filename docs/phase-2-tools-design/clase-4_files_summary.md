# Resumen de clase-4_files.md

1. **Descripción General**: Se registran herramientas en un catálogo tipado, validado con Zod, y ejecutadas mediante handlers. Herramientas de riesgo medio/alto requieren confirmación HITL. Incluye `read_file`, `write_file` y `edit_file` con respuestas JSON explícitas.

2. **Funcionamiento del Catálogo y Runtime**: Estructura del `TOOL_CATALOG` y `TOOL_SCHEMAS`, manejo de herramientas habilitadas y confirmación para herramientas de riesgo.

3. **Decisiones de Diseño**: Recomendaciones sobre riesgo, alcance de paths y manejo de operaciones de archivos. Respuestas JSON estables y claras.

4. **Textos de Catálogo**: Descripciones en inglés para el modelo y en español para la interfaz de usuario.

5. **Implementación**: Archivos a modificar y pruebas manuales sugeridas para verificar funcionamiento.

### Herramientas Descritas
- **`read_file`**: Lee un archivo de texto existente.
- **`write_file`**: Crea un nuevo archivo solo si no existe.
- **`edit_file`**: Modifica un archivo existente reemplazando un texto.

---

Firma: tatisar